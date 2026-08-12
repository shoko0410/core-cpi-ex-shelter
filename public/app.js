/* Core CPI ex-shelter viewer — hand-rolled SVG so the mark specs (2px lines,
   hairline solid grid, 2px surface rings, selective end labels) are exact. */
(function () {
  'use strict';

  const D = window.CPI_DATA;
  const root = document.documentElement;

  if (!D) {
    document.body.innerHTML =
      '<p style="padding:48px;font-family:system-ui">데이터를 불러오지 못했습니다. ' +
      '<code>npm run fetch</code> 를 먼저 실행하세요.</p>';
    return;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  };
  const div = (cls) => {
    const n = document.createElement('div');
    if (cls) n.className = cls;
    return n;
  };
  const cssVar = (name) => getComputedStyle(root).getPropertyValue(name).trim();

  const pct = (v, dp) => (v == null ? '—' : (v >= 0 ? '' : '') + v.toFixed(dp == null ? 1 : dp) + '%');
  const monthKo = (m) => {
    const [y, mo] = m.split('-');
    return `${y}년 ${Number(mo)}월`;
  };

  /* Color follows the entity: each series owns a CSS variable, resolved fresh on
     every render so a theme change repaints without reassigning identity. A
     hidden series never causes the survivors to be recolored. */
  // The sticky series come from FRED, so they are absent when the fetch ran without
  // a key. Filtering here keeps every downstream consumer from having to check.
  const YOY_SERIES = [
    { key: 'coreExShelter', name: 'Core ex-주거비', varName: '--series-coreExShelter' },
    { key: 'headline', name: '헤드라인 CPI', varName: '--series-headline' },
    { key: 'core', name: 'Core CPI', varName: '--series-core' },
    { key: 'shelter', name: '주거비', varName: '--series-shelter' },
    { key: 'stickyExShelter', name: 'Sticky ex-주거비', varName: '--series-stickyExShelter' },
  ].filter((s) => D.series[s.key]).map((s) => ({ ...s, values: D.series[s.key].yoy }));

  const MOM_SERIES = [
    { key: 'ann3m', name: '3개월 연율', varName: '--series-ann3m', values: D.series.coreExShelter.ann3m },
    { key: 'ann6m', name: '6개월 연율', varName: '--series-ann6m', values: D.series.coreExShelter.ann6m },
    D.series.stickyExShelter && {
      key: 'stickyAnn3m', name: 'Sticky 3개월 연율',
      varName: '--series-stickyAnn3m', values: D.series.stickyExShelter.ann3m,
    },
  ].filter(Boolean);

  const RANGES = [
    { id: 'all', label: '전체', months: null },
    { id: '40y', label: '40년', months: 480 },
    { id: '20y', label: '20년', months: 240 },
    { id: '10y', label: '10년', months: 120 },
    { id: '5y', label: '5년', months: 60 },
    { id: '3y', label: '3년', months: 36 },
  ];

  const missingSet = new Set(D.missing || []);

  const state = {
    range: 'all',
    hidden: { yoy: new Set(), mom: new Set() },
    tableOpen: false,
  };

  /* The first month where the star series has a YoY value — earlier months are
     an axis with nothing on it. */
  const firstIdx = (() => {
    const v = D.series.coreExShelter.yoy;
    for (let i = 0; i < v.length; i++) if (v[i] != null) return i;
    return 0;
  })();

  function slice() {
    const end = D.months.length;
    const r = RANGES.find((x) => x.id === state.range);
    const start = r.months == null ? firstIdx : Math.max(firstIdx, end - r.months);
    return { start, end };
  }

  // ------------------------------------------------------------ scales

  function niceDomain(lo, hi) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 2.5);
    const span = hi - lo || 1;
    const steps = [0.25, 0.5, 1, 2, 2.5, 5];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if (span / s <= 6) { step = s; break; }
    }
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil((hi + span * 0.06) / step) * step;
    const ticks = [];
    for (let v = min; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
    return { min, max, ticks };
  }

  function xTicks(start, end) {
    const months = end - start;
    const years = months / 12;
    const out = [];
    if (years <= 4) {
      for (let i = start; i < end; i++) {
        const [, mo] = D.months[i].split('-');
        if (mo === '01' || mo === '07') out.push({ i, label: D.months[i].replace('-', '.') });
      }
    } else {
      const step = years <= 12 ? 2 : years <= 26 ? 5 : 10;
      for (let i = start; i < end; i++) {
        const [y, mo] = D.months[i].split('-');
        if (mo === '01' && Number(y) % step === 0) out.push({ i, label: y });
      }
    }
    return out;
  }

  // ------------------------------------------------------------ chart

  function createChart(host, spec) {
    const tip = div('tip');
    tip.setAttribute('role', 'status');
    host.appendChild(tip);

    let geom = null; // kept for the pointer handler between renders

    function render() {
      const { start, end } = slice();
      const n = end - start;
      const hidden = state.hidden[spec.group];
      const shown = spec.series.filter((s) => !hidden.has(s.key));

      // Use the real container width — a floor above it would make the viewBox
      // scale down and squish the plot on small phones.
      const W = Math.max(host.clientWidth || 640, 240);
      // Height tracks width so the plot keeps its proportions as the window grows,
      // bounded so it never collapses on a phone or overflows a short window.
      const H = Math.round(Math.max(
        spec.minH,
        Math.min(W * spec.ratio, spec.maxH, innerHeight * 0.62)
      ));
      const narrow = W < 560;
      const M = {
        top: 14,
        right: narrow ? 42 : 62, // room for the end labels
        bottom: 28,
        left: narrow ? 36 : 46,
      };
      const iw = W - M.left - M.right;
      const ih = H - M.top - M.bottom;

      let lo = Infinity, hi = -Infinity;
      for (const s of shown) {
        for (let i = start; i < end; i++) {
          const v = s.values[i];
          if (v == null) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (!Number.isFinite(lo)) { lo = 0; hi = 4; }
      const dom = niceDomain(lo, hi);

      const X = (i) => M.left + (n <= 1 ? iw / 2 : ((i - start) / (n - 1)) * iw);
      const Y = (v) => M.top + ih * (1 - (v - dom.min) / (dom.max - dom.min));
      geom = { X, Y, start, end, n, M, iw, ih, shown, dom };

      const svg = el('svg', {
        viewBox: `0 0 ${W} ${H}`,
        width: W,
        height: H,
        'aria-hidden': 'true',
      });

      const ink = {
        grid: cssVar('--gridline'),
        base: cssVar('--baseline'),
        muted: cssVar('--text-muted'),
        secondary: cssVar('--text-secondary'),
        primary: cssVar('--text-primary'),
        surface: cssVar('--surface-1'),
        recession: cssVar('--recession-band'),
        gap: cssVar('--gap-band'),
      };

      const clampX = (x) => Math.max(M.left, Math.min(M.left + iw, x));

      // --- recession bands, behind everything
      for (const r of D.recessions || []) {
        const a = D.months.indexOf(r.start);
        const b = D.months.indexOf(r.end);
        if (a < 0 || b < 0 || b < start || a >= end) continue;
        const x1 = clampX(X(Math.max(a, start)));
        const x2 = clampX(X(Math.min(b, end - 1)));
        if (x2 - x1 < 0.5) continue;
        svg.appendChild(el('rect', {
          x: x1, y: M.top, width: x2 - x1, height: ih, fill: ink.recession,
        }));
      }

      // --- unpublished months, so a break in the line is explained rather than mysterious
      for (const m of missingSet) {
        const i = D.months.indexOf(m);
        if (i < start || i >= end) continue;
        const w = Math.max(2, iw / Math.max(n - 1, 1));
        svg.appendChild(el('rect', {
          x: clampX(X(i) - w / 2), y: M.top, width: w, height: ih, fill: ink.gap,
        }));
      }

      // --- gridlines: hairline, solid, recessive
      for (const t of dom.ticks) {
        const y = Y(t);
        svg.appendChild(el('line', {
          x1: M.left, x2: M.left + iw, y1: y, y2: y,
          stroke: t === 0 ? ink.base : ink.grid, 'stroke-width': 1,
        }));
        const lbl = el('text', {
          x: M.left - 9, y: y + 4, 'text-anchor': 'end',
          fill: ink.muted, 'font-size': 11.5, 'font-family': 'inherit',
          style: 'font-variant-numeric:tabular-nums',
        });
        lbl.textContent = t + '%';
        svg.appendChild(lbl);
      }

      // --- 2% policy target. The rule goes behind the data; its label is added
      //     after the series so no line runs through the text.
      const hasTarget = spec.target != null && spec.target >= dom.min && spec.target <= dom.max;
      if (hasTarget) {
        const y = Y(spec.target);
        svg.appendChild(el('line', {
          x1: M.left, x2: M.left + iw, y1: y, y2: y,
          stroke: ink.base, 'stroke-width': 1.5,
        }));
      }

      // --- x axis
      svg.appendChild(el('line', {
        x1: M.left, x2: M.left + iw, y1: M.top + ih, y2: M.top + ih,
        stroke: ink.base, 'stroke-width': 1,
      }));
      let lastX = -Infinity;
      for (const t of xTicks(start, end)) {
        const x = X(t.i);
        if (x - lastX < 46) continue; // drop labels that would collide
        lastX = x;
        const lbl = el('text', {
          x, y: M.top + ih + 17, 'text-anchor': 'middle',
          fill: ink.muted, 'font-size': 11.5, 'font-family': 'inherit',
          style: 'font-variant-numeric:tabular-nums',
        });
        lbl.textContent = t.label;
        svg.appendChild(lbl);
      }

      // --- series lines, broken across nulls rather than interpolated
      const endPoints = [];
      for (const s of shown) {
        const color = cssVar(s.varName);
        let d = '';
        let pen = false;
        let lastGood = null;
        for (let i = start; i < end; i++) {
          const v = s.values[i];
          if (v == null) { pen = false; continue; }
          d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1) + ' ';
          pen = true;
          lastGood = { i, v };
        }
        if (d) {
          svg.appendChild(el('path', {
            d, fill: 'none', stroke: color, 'stroke-width': 2,
            'stroke-linejoin': 'round', 'stroke-linecap': 'round',
          }));
        }
        if (lastGood) endPoints.push({ s, color, ...lastGood });
      }

      // --- end markers + selective direct labels (value only; the legend carries names)
      const labels = endPoints.map((p) => ({
        p, anchorY: Y(p.v), y: Y(p.v), text: p.v.toFixed(1),
      }));
      labels.sort((a, b) => a.y - b.y);
      const GAP = 15;
      for (let i = 1; i < labels.length; i++) {
        if (labels[i].y - labels[i - 1].y < GAP) labels[i].y = labels[i - 1].y + GAP;
      }
      const overflow = labels.length ? labels[labels.length - 1].y - (M.top + ih) : 0;
      if (overflow > 0) for (const l of labels) l.y -= overflow;
      for (let i = labels.length - 2; i >= 0; i--) {
        if (labels[i + 1].y - labels[i].y < GAP) labels[i].y = labels[i + 1].y - GAP;
      }

      for (const l of labels) {
        const x = X(l.p.i);
        // Leader line only when the label had to leave its point.
        if (Math.abs(l.y - l.anchorY) > 1.5) {
          svg.appendChild(el('path', {
            d: `M${x + 5} ${l.anchorY} L${x + 12} ${l.anchorY} L${x + 16} ${l.y} L${x + 21} ${l.y}`,
            fill: 'none', stroke: l.p.color, 'stroke-width': 1, opacity: 0.55,
          }));
        }
        // 2px surface ring keeps overlapping end dots legible.
        svg.appendChild(el('circle', {
          cx: x, cy: l.anchorY, r: 4.5, fill: l.p.color,
          stroke: ink.surface, 'stroke-width': 2,
        }));
        const t = el('text', {
          x: x + 24, y: l.y + 4, fill: ink.primary, 'font-size': 12,
          'font-weight': 600, 'font-family': 'inherit',
          style: 'font-variant-numeric:tabular-nums',
        });
        t.textContent = l.text;
        svg.appendChild(t);
      }

      // --- target label, on top of the series
      let targetLabel = null;
      if (hasTarget) {
        targetLabel = el('text', {
          x: M.left + 8, y: Y(spec.target) - 7, fill: ink.secondary,
          'font-size': 11, 'font-family': 'inherit',
        });
        // The card subtitle already names the line, so the narrow label can be
        // short rather than eating a third of the plot.
        targetLabel.textContent = narrow ? '2%' : '연준 목표 2%';
        svg.appendChild(targetLabel);
      }

      // --- crosshair layer (hidden until pointer/focus)
      const cross = el('g', { opacity: 0 });
      const crossLine = el('line', {
        y1: M.top, y2: M.top + ih, stroke: ink.muted, 'stroke-width': 1,
      });
      cross.appendChild(crossLine);
      const crossDots = el('g');
      cross.appendChild(crossDots);
      svg.appendChild(cross);

      host.querySelectorAll('svg').forEach((s) => s.remove());
      host.insertBefore(svg, tip);

      // The target label sits inside the plot, so it needs a surface chip behind it
      // or the data lines run straight through the text. getBBox needs the node
      // rendered, hence after insertion.
      if (targetLabel) {
        const b = targetLabel.getBBox();
        svg.insertBefore(el('rect', {
          x: b.x - 4, y: b.y - 1, width: b.width + 8, height: b.height + 2,
          rx: 3, fill: ink.surface, opacity: 0.95,
        }), targetLabel);
      }

      geom.cross = cross;
      geom.crossLine = crossLine;
      geom.crossDots = crossDots;
      geom.ink = ink;
      geom.W = W;
      geom.H = H;
    }

    function showAt(idx) {
      if (!geom) return;
      const { X, Y, M, iw, shown, ink } = geom;
      const i = Math.max(geom.start, Math.min(geom.end - 1, idx));
      const month = D.months[i];
      const x = X(i);

      geom.cross.setAttribute('opacity', '1');
      geom.crossLine.setAttribute('x1', x);
      geom.crossLine.setAttribute('x2', x);
      geom.crossDots.replaceChildren();

      // Untrusted-data rule: every label goes in via textContent, never innerHTML.
      tip.replaceChildren();
      const dateEl = div('tip-date');
      dateEl.textContent = monthKo(month);
      tip.appendChild(dateEl);

      let any = false;
      for (const s of shown) {
        const v = s.values[i];
        const row = div('tip-row');
        const key = div('tip-key');
        key.style.background = cssVar(s.varName);
        const val = div('tip-val');
        val.textContent = pct(v);
        const name = div('tip-name');
        name.textContent = s.name;
        row.append(key, val, name);
        tip.appendChild(row);
        if (v != null) {
          any = true;
          geom.crossDots.appendChild(el('circle', {
            cx: x, cy: Y(v), r: 4, fill: cssVar(s.varName),
            stroke: ink.surface, 'stroke-width': 2,
          }));
        }
      }
      if (missingSet.has(month)) {
        // Sticky-price series still report this month, so blame BLS specifically
        // rather than implying every number here is absent.
        const note = div('tip-missing');
        note.textContent = 'BLS 미발표 (셧다운)';
        tip.appendChild(note);
      } else if (!any) {
        const note = div('tip-missing');
        note.textContent = '해당 월 데이터 없음';
        tip.appendChild(note);
      }

      tip.dataset.show = 'true';
      const tw = tip.offsetWidth || 180;
      const left = x + 16 + tw > M.left + iw + 60 ? x - tw - 16 : x + 16;
      tip.style.left = Math.max(2, left) + 'px';
      tip.style.top = '10px';
      host.dataset.idx = String(i);
    }

    function hide() {
      if (!geom) return;
      geom.cross.setAttribute('opacity', '0');
      tip.dataset.show = 'false';
    }

    function idxFromClientX(clientX) {
      const r = host.getBoundingClientRect();
      const scale = geom.W / r.width;
      const px = (clientX - r.left) * scale;
      const t = (px - geom.M.left) / (geom.iw || 1);
      return geom.start + Math.round(t * (geom.n - 1));
    }

    // The crosshair finds the X — readers aim at a date, not at a 2px line.
    host.addEventListener('pointermove', (e) => geom && showAt(idxFromClientX(e.clientX)));
    host.addEventListener('pointerleave', hide);
    host.addEventListener('focus', () => geom && showAt(Number(host.dataset.idx) || geom.end - 1));
    host.addEventListener('blur', hide);
    host.addEventListener('keydown', (e) => {
      if (!geom) return;
      const cur = Number(host.dataset.idx);
      const i = Number.isFinite(cur) && cur ? cur : geom.end - 1;
      const step = e.shiftKey ? 12 : 1;
      if (e.key === 'ArrowLeft') { showAt(i - step); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { showAt(i + step); e.preventDefault(); }
      else if (e.key === 'Home') { showAt(geom.start); e.preventDefault(); }
      else if (e.key === 'End') { showAt(geom.end - 1); e.preventDefault(); }
      else if (e.key === 'Escape') hide();
    });

    return { render, hide };
  }

  // ------------------------------------------------------------ legend

  function buildLegend(container, series, group, onChange) {
    container.replaceChildren();
    for (const s of series) {
      const b = document.createElement('button');
      b.type = 'button';
      const on = !state.hidden[group].has(s.key);
      b.setAttribute('aria-pressed', String(on));
      const key = div('legend-key');
      key.style.background = cssVar(s.varName);
      const label = document.createElement('span');
      label.textContent = s.name;
      b.append(key, label);
      b.addEventListener('click', () => {
        const set = state.hidden[group];
        if (set.has(s.key)) set.delete(s.key);
        else if (series.length - set.size > 1) set.add(s.key); // never hide the last one
        buildLegend(container, series, group, onChange);
        onChange();
      });
      container.appendChild(b);
    }
  }

  // ------------------------------------------------------------ header stats

  function lastValue(arr, upTo) {
    for (let i = upTo; i >= 0; i--) if (arr[i] != null) return { v: arr[i], i };
    return { v: null, i: -1 };
  }

  function renderStats() {
    const last = D.months.length - 1;
    const ex = D.series.coreExShelter;
    const cur = lastValue(ex.yoy, last);
    const prev = cur.i > 0 ? lastValue(ex.yoy, cur.i - 1) : { v: null };

    document.getElementById('hero-value').textContent = pct(cur.v);
    const dEl = document.getElementById('hero-delta');
    if (cur.v != null && prev.v != null) {
      const d = cur.v - prev.v;
      dEl.textContent = (d > 0 ? '▲ +' : d < 0 ? '▼ ' : '– ') + d.toFixed(2) + 'p';
      dEl.className = 'delta ' + (d > 0.005 ? 'up' : d < -0.005 ? 'down' : 'flat');
      dEl.title = '직전 발표월 대비';
    }
    document.getElementById('hero-meta').textContent =
      `${monthKo(D.months[cur.i])} · 식료품·에너지·주거비 제외 · 출처 BLS`;

    const tiles = [
      { label: '3개월 연율화', ...lastValue(ex.ann3m, last), note: '계절조정 기준' },
      { label: '6개월 연율화', ...lastValue(ex.ann6m, last), note: '계절조정 기준' },
      D.series.stickyExShelter && {
        label: 'Sticky ex-주거비',
        ...lastValue(D.series.stickyExShelter.yoy, last),
        note: '전년 대비 · 애틀랜타 연준',
      },
      { label: 'Core CPI (비교)', ...lastValue(D.series.core.yoy, last), note: '주거비 포함' },
      { label: '주거비 단독', ...lastValue(D.series.shelter.yoy, last), note: '전년 대비' },
    ].filter(Boolean);
    const host = document.getElementById('tiles');
    host.replaceChildren();
    for (const t of tiles) {
      const c = div('tile');
      const l = div('tile-label'); l.textContent = t.label;
      const v = div('tile-value'); v.textContent = pct(t.v);
      const nEl = div('tile-note');
      nEl.textContent = t.i >= 0 ? `${D.months[t.i].replace('-', '.')} · ${t.note}` : t.note;
      c.append(l, v, nEl);
      host.appendChild(c);
    }
  }

  // ------------------------------------------------------------ table view

  function renderTable() {
    const wrap = document.getElementById('table-wrap');
    if (!state.tableOpen) return;
    const { start, end } = slice();
    const sticky = D.series.stickyExShelter;
    const cols = [
      { h: 'Core ex-주거비', get: (i) => D.series.coreExShelter.yoy[i] },
      { h: '헤드라인', get: (i) => D.series.headline.yoy[i] },
      { h: 'Core', get: (i) => D.series.core.yoy[i] },
      { h: '주거비', get: (i) => D.series.shelter.yoy[i] },
      sticky && { h: 'Sticky ex-주거비', get: (i) => sticky.yoy[i] },
      { h: '3m 연율', ann: true, get: (i) => D.series.coreExShelter.ann3m[i] },
      { h: '6m 연율', ann: true, get: (i) => D.series.coreExShelter.ann6m[i] },
      sticky && { h: 'Sticky 3m', ann: true, get: (i) => sticky.ann3m[i] },
    ].filter(Boolean);
    const yoyCols = cols.filter((c) => !c.ann).length;

    const table = document.createElement('table');
    const cap = document.createElement('caption');
    cap.textContent =
      `${D.months[start].replace('-', '.')} ~ ${D.months[end - 1].replace('-', '.')} · ` +
      `단위 % · 앞 ${yoyCols}개 열은 전년 대비, 나머지는 연율화 · 미발표 월은 —`;
    table.appendChild(cap);

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['월', ...cols.map((c) => c.h)]) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (let i = end - 1; i >= start; i--) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.scope = 'row';
      th.style.textAlign = 'left';
      th.style.fontWeight = '400';
      th.textContent = D.months[i];
      tr.appendChild(th);
      for (const c of cols) {
        const td = document.createElement('td');
        const v = c.get(i);
        td.textContent = v == null ? '—' : v.toFixed(2);
        if (v == null) td.className = 'na';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.replaceChildren(table);
  }

  // ------------------------------------------------------------ wiring

  const chartYoy = createChart(document.getElementById('chart-yoy'), {
    group: 'yoy', series: YOY_SERIES, ratio: 0.34, minH: 260, maxH: 560, target: 2,
  });
  const chartMom = createChart(document.getElementById('chart-mom'), {
    group: 'mom', series: MOM_SERIES, ratio: 0.27, minH: 230, maxH: 440, target: 2,
  });

  function renderAll() {
    chartYoy.render();
    chartMom.render();
    renderTable();
  }

  const seg = document.getElementById('range-seg');
  for (const r of RANGES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = r.label;
    b.setAttribute('aria-pressed', String(state.range === r.id));
    b.addEventListener('click', () => {
      state.range = r.id;
      seg.querySelectorAll('button').forEach((x, k) =>
        x.setAttribute('aria-pressed', String(RANGES[k].id === r.id)));
      renderAll();
    });
    seg.appendChild(b);
  }

  buildLegend(document.getElementById('legend-yoy'), YOY_SERIES, 'yoy', renderAll);
  buildLegend(document.getElementById('legend-mom'), MOM_SERIES, 'mom', renderAll);

  const tableBtn = document.getElementById('table-toggle');
  tableBtn.addEventListener('click', () => {
    state.tableOpen = !state.tableOpen;
    document.getElementById('table-wrap').hidden = !state.tableOpen;
    tableBtn.setAttribute('aria-expanded', String(state.tableOpen));
    tableBtn.textContent = state.tableOpen ? '표 닫기' : '표 열기';
    renderTable();
  });

  const themeBtn = document.getElementById('theme-toggle');
  const savedTheme = localStorage.getItem('cpi-theme');
  if (savedTheme) root.dataset.theme = savedTheme;
  else root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const syncThemeBtn = () => {
    const dark = root.dataset.theme === 'dark';
    themeBtn.textContent = dark ? '☀ 라이트' : '🌙 다크';
    themeBtn.setAttribute('aria-label', dark ? '라이트 모드로 전환' : '다크 모드로 전환');
  };
  themeBtn.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('cpi-theme', root.dataset.theme);
    syncThemeBtn();
    buildLegend(document.getElementById('legend-yoy'), YOY_SERIES, 'yoy', renderAll);
    buildLegend(document.getElementById('legend-mom'), MOM_SERIES, 'mom', renderAll);
    renderAll();
  });
  syncThemeBtn();

  document.getElementById('generated-note').textContent =
    `데이터 최종 변경 ${new Date(D.generatedAt).toLocaleString('ko-KR')} · ` +
    `수록 범위 ${D.months[firstIdx]} ~ ${D.latestMonth} · ` +
    `매일 자동으로 BLS를 확인해 값이 바뀔 때만 갱신합니다.`;

  renderStats();
  renderAll();

  let raf = 0;
  const scheduleRender = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderAll);
  };

  // Window resize covers both axes — including a height-only drag, which changes
  // the charts because their height is capped against innerHeight.
  addEventListener('resize', scheduleRender);

  // Container-driven width changes the window event misses: a scrollbar appearing,
  // zoom, or the table view widening the page. Guarded on width so the taller SVG
  // this render produces cannot re-trigger the observer.
  let lastW = 0;
  new ResizeObserver((entries) => {
    const w = entries[0].contentRect.width;
    if (Math.abs(w - lastW) < 0.5) return;
    lastW = w;
    scheduleRender();
  }).observe(document.querySelector('.wrap'));
})();
