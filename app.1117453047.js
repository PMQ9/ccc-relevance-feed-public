/* CCC relevance dashboard — client-side renderer + controls.
 *
 * Architecture: index.html is a small static shell with skeleton placeholders.
 * This script fetches feed.json, renders posts + info bar + summary into the
 * placeholders, then wires up controls. Auto-refreshes every ~15 min so tabs
 * left open all day pick up new pushes without manual reload.
 *
 * Air-gap: no external network calls beyond the same-origin feed.json.
 * No deps. Vanilla DOM. Hash-named by render.py — keep free of dynamic content
 * (anything that changes per-render lives in index.html meta tags).
 */
(function () {
  "use strict";

  const STATIC_PAGE_PATHS = new Set(["", "index.html", "dashboard.html"]);

  /* ---------- HTML escaping (mirrors Python html.escape) ---------- */
  function esc(s) {
    if (s === undefined || s === null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  /* ---------- Cron parsing — next scheduled tick from the cron meta tag ---------- */
  function expandCronField(expr, lo, hi) {
    const out = new Set();
    for (let part of String(expr || "").split(",")) {
      part = part.trim();
      if (!part) continue;
      let step = 1, base = part;
      if (part.includes("/")) {
        const ix = part.indexOf("/");
        base = part.slice(0, ix);
        step = parseInt(part.slice(ix + 1), 10);
      }
      let start, end;
      if (base === "*") { start = lo; end = hi; }
      else if (base.includes("-")) {
        const [a, b] = base.split("-");
        start = parseInt(a, 10); end = parseInt(b, 10);
      } else {
        start = end = parseInt(base, 10);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step)) continue;
      for (let v = start; v <= end; v += step) {
        if (v >= lo && v <= hi) out.add(v);
      }
    }
    return out;
  }

  function nextCronTick(cronExpr, after) {
    const fields = String(cronExpr || "").trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const minutes = expandCronField(fields[0], 0, 59);
    const hours = expandCronField(fields[1], 0, 23);
    const doms = expandCronField(fields[2], 1, 31);
    const months = expandCronField(fields[3], 1, 12);
    /* Cron day-of-week: 0 or 7 = Sun, 1=Mon..6=Sat. JS getUTCDay(): Sun=0..Sat=6. */
    const dowCron = expandCronField(fields[4], 0, 7);
    const dows = new Set();
    for (const d of dowCron) dows.add(d === 7 ? 0 : d);
    if (!minutes.size || !hours.size || !doms.size || !months.size || !dows.size) return null;
    let t = new Date(after.getTime());
    t.setUTCSeconds(0, 0);
    t = new Date(t.getTime() + 60_000); /* strictly after */
    const limit = 60 * 24 * 8; /* 8 days of minutes */
    for (let i = 0; i < limit; i++) {
      if (minutes.has(t.getUTCMinutes())
        && hours.has(t.getUTCHours())
        && doms.has(t.getUTCDate())
        && months.has(t.getUTCMonth() + 1)
        && dows.has(t.getUTCDay())) {
        return t;
      }
      t = new Date(t.getTime() + 60_000);
    }
    return null;
  }

  function parseIso(s) {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatAge(then, now) {
    if (!then) return "never";
    const secs = (now.getTime() - then.getTime()) / 1000;
    if (secs < 0) return "just now";
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 48 * 3600) return `${Math.round(secs / 3600)}h ago`;
    return `${Math.round(secs / 86400)}d ago`;
  }

  function staleSourceNames(collectorStatus, generatedAt) {
    const genDt = parseIso(generatedAt) || new Date();
    const stale = [];
    for (const [name, status] of Object.entries(collectorStatus || {})) {
      const budget = status.expected_max_silence_hours;
      if (budget === undefined || budget === null) continue;
      const last = parseIso(status.last_success_with_results);
      if (!last) { stale.push(name); continue; }
      if ((genDt.getTime() - last.getTime()) / 3_600_000 > Number(budget)) {
        stale.push(name);
      }
    }
    stale.sort();
    return stale;
  }

  /* ---------- Post renderers — mirror _render_post / _render_summary ---------- */
  function renderPost(p) {
    const score = Number(p.score || 0);
    const scoreCls = score >= 0.6 ? "high" : (score >= 0.4 ? "mid" : "low");
    const tier = parseInt(p.source_tier || 0, 10);
    const matched = p.matched_entities || [];
    const components = p.components || {};
    const entitiesHtml = matched.map(
      m => `<span class="entity">${esc(m.entity || "")}</span>`
    ).join(" ");
    /* Components 0-1 internally; ×10 to match the 0-10 display scale. */
    const compStr = (
      `E:${(Number(components.entity_score || 0) * 10).toFixed(1)} `
      + `S:${((Number(components.source_bonus || 0) * 10) >= 0 ? "+" : "")}${(Number(components.source_bonus || 0) * 10).toFixed(1)} `
      + `R:${((Number(components.recency_bonus || 0) * 10) >= 0 ? "+" : "")}${(Number(components.recency_bonus || 0) * 10).toFixed(1)}`
    );
    const title = p.title || "(no title)";
    const excerpt = p.excerpt || "";
    const url = p.url || "";
    const source = p.source || "";
    const platform = p.platform || "";
    const postedAt = p.posted_at || "";

    const searchText = [
      title, excerpt, source,
      matched.map(m => m.entity || "").join(" "),
    ].join(" | ");

    const promoteAttrs = (
      `data-url="${esc(url)}" `
      + `data-title="${esc(title)}" `
      + `data-excerpt="${esc(excerpt.slice(0, 500))}" `
      + `data-source="${esc(source)}" `
      + `data-tier="${tier}" `
      + `data-score="${score.toFixed(3)}" `
      + `data-entities="${esc(JSON.stringify(matched.map(m => m.entity || "")))}"`
    );

    const excerptHtml = esc(excerpt.slice(0, 300)) + (excerpt.length > 300 ? "&hellip;" : "");

    return `
<div class="post" data-score="${score.toFixed(3)}" data-search="${esc(searchText)}">
  <div class="score-cell">
    <div class="num ${scoreCls}">${(score * 10).toFixed(1)}</div>
    <div class="components dev-only" title="entity / source / recency">${esc(compStr)}</div>
  </div>
  <div class="post-body">
    <div class="title"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a></div>
    <div class="excerpt">${excerptHtml}</div>
    <div class="meta">
      <span class="badge tier-${tier}">tier ${tier}</span>
      <span class="badge">${esc(source)}</span>
      <span class="badge platform">${esc(platform)}</span>
      <span>${esc(postedAt)}</span>
    </div>
    <div class="entities">${entitiesHtml}</div>
  </div>
  <div class="actions">
    <a class="open-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">open</a>
    <button class="promote" ${promoteAttrs}>promote</button>
    <button class="dismiss">dismiss</button>
  </div>
</div>`;
  }

  function renderFeed(posts) {
    if (!posts.length) {
      return `<div class="empty">No posts in this snapshot. Check collector freshness above, or lower the score threshold.</div>`;
    }
    const byDay = new Map();
    const undated = [];
    for (const p of posts) {
      const day = (p.posted_at || "").slice(0, 10);
      if (day) {
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(p);
      } else {
        undated.push(p);
      }
    }
    const out = [];
    const days = Array.from(byDay.keys()).sort().reverse();
    for (const day of days) {
      out.push('<div class="day-group">');
      out.push(`  <h2>${esc(day)}</h2>`);
      for (const p of byDay.get(day)) out.push(renderPost(p));
      out.push("</div>");
    }
    if (undated.length) {
      /* Static landing pages / faculty bios — high-score but not news. Collapsed
         by default so they don't dominate the feed. */
      undated.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      out.push('<details class="undated-block">');
      out.push(`  <summary>Static / undated pages <span class="count">(${undated.length})</span></summary>`);
      out.push('  <div class="day-group undated-group">');
      for (const p of undated) out.push(renderPost(p));
      out.push("  </div>");
      out.push("</details>");
    }
    return out.join("\n");
  }

  function renderSummary(posts) {
    const n = posts.length;
    let high = 0, mid = 0, low = 0;
    const sources = new Set();
    const tiers = {};
    for (const p of posts) {
      const s = Number(p.score || 0);
      if (s >= 0.6) high++;
      else if (s >= 0.4) mid++;
      else low++;
      if (p.source) sources.add(p.source);
      const t = parseInt(p.source_tier || 0, 10);
      tiers[t] = (tiers[t] || 0) + 1;
    }
    const tierKeys = Object.keys(tiers).map(Number).sort((a, b) => a - b);
    const tierStr = tierKeys.map(t => `T${t}:${tiers[t]}`).join(" ");
    return `
    <div class="stat"><span class="n">${n}</span><span class="lbl">total visible</span></div>
    <div class="stat"><span class="n">${high}</span><span class="lbl">score &ge; 6.0</span></div>
    <div class="stat"><span class="n">${mid}</span><span class="lbl">4.0&ndash;5.9</span></div>
    <div class="stat"><span class="n">${low}</span><span class="lbl">below 4.0</span></div>
    <div class="stat"><span class="n">${sources.size}</span><span class="lbl">sources</span></div>
    <div class="stat dev-only"><span class="n">${esc(tierStr) || "&mdash;"}</span><span class="lbl">by tier</span></div>
    `;
  }

  function renderInfoBar(collectorStatus, posts, generatedAt, cronExpr) {
    const genDt = parseIso(generatedAt) || new Date();
    const lastUpdatedIso = generatedAt ? genDt.toISOString() : "";
    const lastUpdatedFallback = generatedAt
      ? `${genDt.getUTCFullYear()}-${String(genDt.getUTCMonth() + 1).padStart(2, "0")}-${String(genDt.getUTCDate()).padStart(2, "0")} ${String(genDt.getUTCHours()).padStart(2, "0")}:${String(genDt.getUTCMinutes()).padStart(2, "0")} UTC`
      : "unknown";

    const nxt = cronExpr ? nextCronTick(cronExpr, genDt) : null;
    let nextIso = "", nextFallback = "unknown";
    if (nxt) {
      nextIso = nxt.toISOString();
      const wk = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][nxt.getUTCDay()];
      nextFallback = `${nxt.getUTCFullYear()}-${String(nxt.getUTCMonth() + 1).padStart(2, "0")}-${String(nxt.getUTCDate()).padStart(2, "0")} ${String(nxt.getUTCHours()).padStart(2, "0")}:${String(nxt.getUTCMinutes()).padStart(2, "0")} UTC (${wk})`;
    }
    const nextCronAttr = cronExpr ? ` data-cron="${esc(cronExpr)}"` : "";

    const staleSet = new Set(staleSourceNames(collectorStatus, generatedAt));
    let sourcesHtml, sourceLabel;
    if (collectorStatus && Object.keys(collectorStatus).length) {
      const names = Object.keys(collectorStatus).sort();
      const items = names.map(name => {
        const status = collectorStatus[name] || {};
        const last = parseIso(status.last_success_with_results);
        const age = formatAge(last, genDt);
        const cls = staleSet.has(name) ? "src stale" : "src";
        return `<span class="${cls}"><code>${esc(name)}</code><span class="age">${esc(age)}</span></span>`;
      }).join("");
      sourcesHtml = `<div class="sources-list">${items}</div>`;
      sourceLabel = `Sources (${names.length})`;
    } else {
      const names = Array.from(new Set(posts.map(p => p.source).filter(Boolean))).sort();
      const items = names.map(n => `<span class="src"><code>${esc(n)}</code></span>`).join("");
      sourcesHtml = names.length ? `<div class="sources-list">${items}</div>` : '<span class="val">(none)</span>';
      sourceLabel = `Sources (${names.length})`;
    }

    return (
      '<div class="info-bar">'
      + '<span class="lbl">Last updated</span>'
      + `<span class="val" data-iso="${esc(lastUpdatedIso)}">${esc(lastUpdatedFallback)}</span>`
      + '<span class="lbl">Next update</span>'
      + `<span class="val" data-iso="${esc(nextIso)}"${nextCronAttr}>${esc(nextFallback)}</span>`
      + `<span class="lbl dev-only">${esc(sourceLabel)}</span>`
      + `<span class="val dev-only">${sourcesHtml}</span>`
      + "</div>"
    );
  }

  function renderFreshnessBanner(collectorStatus, generatedAt) {
    const genDt = parseIso(generatedAt) || new Date();
    const rows = [];
    for (const name of staleSourceNames(collectorStatus, generatedAt)) {
      const status = (collectorStatus || {})[name] || {};
      const budget = status.expected_max_silence_hours;
      const last = parseIso(status.last_success_with_results);
      const hoursStr = !last
        ? "never"
        : `${Math.round((genDt.getTime() - last.getTime()) / 3_600_000)}h ago`;
      const err = status.error || "";
      const errStr = err ? ` <span class="dev-only">&mdash; <code>${esc(err)}</code></span>` : "";
      rows.push(
        `<li><code>${esc(name)}</code>: last result ${hoursStr} `
        + `<span class="dev-only">(budget ${Number(budget).toFixed(0)}h)</span>${errStr}</li>`
      );
    }
    if (!rows.length) return "";
    return (
      '<div class="freshness-banner dev-only">'
      + '<div class="title">Stale collectors</div>'
      + `<ul>${rows.join("")}</ul>`
      + "</div>"
    );
  }

  function renderLinkedinCards(savedSearches) {
    if (!savedSearches || !savedSearches.length) return "";
    const cards = savedSearches.map(s => {
      const label = esc(s.label || "saved search");
      const url = esc(s.url || "#");
      const desc = esc(s.description || "");
      const descHtml = desc ? `<span class="desc">${desc}</span>` : "";
      return `<a class="card" href="${url}" target="_blank" rel="noopener noreferrer"><span class="label">${label}</span>${descHtml}</a>`;
    }).join("");
    return (
      '<div class="linkedin-cards">'
      + "<h2>LinkedIn saved searches</h2>"
      + `<div class="cards">${cards}</div>`
      + "</div>"
    );
  }

  /* ---------- Theme / mode / tz (unchanged from prior IIFE) ---------- */
  const root = document.documentElement;
  const body = document.body;
  const themeBtn = document.getElementById("theme-toggle");
  const modeBtn = document.getElementById("mode-toggle");
  const live = document.getElementById("live-region");

  const THEME_KEY = "ccc-feed-theme";
  const MODE_KEY = "ccc-feed-mode";
  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

  function effectiveDark(theme) {
    if (theme === "dark") return true;
    if (theme === "light") return false;
    return systemDark.matches;
  }

  function applyTheme(theme) {
    root.setAttribute("data-theme", theme);
    const dark = effectiveDark(theme);
    themeBtn.setAttribute("aria-pressed", dark ? "true" : "false");
    themeBtn.textContent = dark ? "Dark" : "Light";
  }

  function applyMode(mode) {
    body.setAttribute("data-mode", mode);
    const dev = mode === "dev";
    modeBtn.setAttribute("aria-pressed", dev ? "true" : "false");
    modeBtn.textContent = dev ? "Dev mode" : "User mode";
  }

  function announce(msg) {
    if (!live) return;
    live.textContent = "";
    /* Microtask gap so AT picks up the change. */
    setTimeout(() => { live.textContent = msg; }, 50);
  }

  let currentTheme = safeGet(THEME_KEY) || "auto";
  if (currentTheme !== "dark" && currentTheme !== "light" && currentTheme !== "auto") {
    currentTheme = "auto";
  }
  let currentMode = safeGet(MODE_KEY) === "dev" ? "dev" : "user";
  applyTheme(currentTheme);
  applyMode(currentMode);

  themeBtn.addEventListener("click", () => {
    currentTheme = effectiveDark(currentTheme) ? "light" : "dark";
    safeSet(THEME_KEY, currentTheme);
    applyTheme(currentTheme);
    announce(currentTheme === "dark" ? "Dark theme enabled" : "Light theme enabled");
  });

  modeBtn.addEventListener("click", () => {
    currentMode = currentMode === "dev" ? "user" : "dev";
    safeSet(MODE_KEY, currentMode);
    applyMode(currentMode);
    announce(currentMode === "dev" ? "Developer mode on" : "User mode on");
  });

  systemDark.addEventListener("change", () => {
    if (currentTheme === "auto") applyTheme("auto");
  });

  /* Timezone display. ISO timestamps live in data-iso attributes; format here. */
  const TZ_KEY = "ccc-feed-tz";
  const DEFAULT_TZ = "America/Chicago";
  const tzSelect = document.getElementById("tz-select");
  let currentTz = safeGet(TZ_KEY) || DEFAULT_TZ;
  const allowed = ["America/Chicago", "America/New_York", "America/Denver", "America/Los_Angeles", "UTC"];
  if (!allowed.includes(currentTz)) currentTz = DEFAULT_TZ;
  tzSelect.value = currentTz;

  function refreshCronIso() {
    document.querySelectorAll("[data-cron]").forEach(el => {
      const cron = el.getAttribute("data-cron");
      const next = nextCronTick(cron, new Date());
      if (next) el.setAttribute("data-iso", next.toISOString());
    });
  }

  function formatIso(iso, tz) {
    if (!iso) return "unknown";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown";
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
        weekday: "short", timeZoneName: "short",
      }).formatToParts(d);
      const p = {};
      for (const x of parts) if (x.type !== "literal") p[x.type] = x.value;
      const hour = p.hour === "24" ? "00" : p.hour;
      return `${p.year}-${p.month}-${p.day} ${hour}:${p.minute} ${p.timeZoneName} (${p.weekday})`;
    } catch (e) {
      return iso;
    }
  }

  function applyTz() {
    refreshCronIso();
    document.querySelectorAll("[data-iso]").forEach(el => {
      const iso = el.getAttribute("data-iso");
      if (iso) el.textContent = formatIso(iso, currentTz);
    });
  }

  tzSelect.addEventListener("change", () => {
    currentTz = tzSelect.value;
    safeSet(TZ_KEY, currentTz);
    applyTz();
  });

  /* Refresh "Next update" + ages every 30s so a tab left open stays honest. */
  setInterval(applyTz, 30_000);

  /* ---------- Threshold + filter controls (live across re-renders) ---------- */
  const th = document.getElementById("threshold");
  const thVal = document.getElementById("threshold-val");
  const filter = document.getElementById("filter");

  function applyFilter() {
    /* Slider 0-10 (staff scale); data-score 0-1 (schema contract). */
    const tDisplay = parseFloat(th.value);
    thVal.textContent = tDisplay.toFixed(1);
    const t = tDisplay / 10;
    const q = filter.value.trim().toLowerCase();
    document.querySelectorAll("#feed .post").forEach(p => {
      const s = parseFloat(p.dataset.score);
      const text = (p.dataset.search || "").toLowerCase();
      const show = s >= t && (q === "" || text.includes(q));
      p.style.display = show ? "" : "none";
    });
    document.querySelectorAll("#feed .day-group").forEach(g => {
      const anyShown = Array.from(g.querySelectorAll(".post"))
        .some(p => p.style.display !== "none");
      g.style.display = anyShown ? "" : "none";
    });
  }

  th.addEventListener("input", applyFilter);
  filter.addEventListener("input", applyFilter);

  /* ---------- Promote / dismiss (delegated; survives re-render) ---------- */
  document.getElementById("feed").addEventListener("click", async (ev) => {
    const promote = ev.target.closest("button.promote");
    const dismiss = ev.target.closest("button.dismiss");
    if (promote) {
      const payload = {
        source: { kind: "url", summary: promote.dataset.title, links: [promote.dataset.url] },
        relevance_feed: {
          score: parseFloat(promote.dataset.score),
          matched_entities: JSON.parse(promote.dataset.entities || "[]"),
          source_name: promote.dataset.source,
          source_tier: parseInt(promote.dataset.tier, 10),
        },
        title: promote.dataset.title,
        excerpt: promote.dataset.excerpt,
        url: promote.dataset.url,
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
        promote.textContent = "copied";
        const row = promote.closest(".post");
        if (row) row.classList.add("promoted");
        setTimeout(() => { promote.textContent = "promote"; }, 1500);
      } catch (e) {
        alert("clipboard unavailable in this context, copy the URL manually:\n\n" + promote.dataset.url);
      }
    } else if (dismiss) {
      const row = dismiss.closest(".post");
      if (row) row.classList.add("dismissed");
    }
  });

  /* Escape dismisses the score-info tooltip (WCAG 1.4.13). */
  const infoBtn = document.querySelector(".info-btn");
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && infoBtn && document.activeElement === infoBtn) {
      infoBtn.blur();
    }
  });

  /* ---------- Fetch + render orchestration ---------- */
  function getMeta(name) {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute("content") || "" : "";
  }

  function renderError(msg) {
    const feedEl = document.getElementById("feed");
    feedEl.innerHTML = (
      '<div class="feed-error">'
      + '<div class="title">Couldn\'t load feed data</div>'
      + `<div class="detail">${esc(msg)}</div>`
      + '<div class="detail">Try refreshing the page, or open the raw data: '
      + '<a href="./feed.json">feed.json</a></div>'
      + "</div>"
    );
  }

  function renderAll(feed) {
    const posts = feed.posts || [];
    const collectorStatus = feed.collector_status || {};
    const savedSearches = feed.linkedin_saved_searches || [];
    const generatedAt = feed.generated_at || "";
    const cronExpr = getMeta("cron");

    /* Update header summary line */
    const summaryLine = document.getElementById("summary-line");
    if (summaryLine) {
      const nSources = new Set(posts.map(p => p.source).filter(Boolean)).size;
      summaryLine.textContent = `${posts.length} posts from ${nSources} sources`;
    }

    /* Populate placeholders */
    document.getElementById("info-bar-mount").innerHTML = renderInfoBar(collectorStatus, posts, generatedAt, cronExpr);
    document.getElementById("freshness-banner-mount").innerHTML = renderFreshnessBanner(collectorStatus, generatedAt);
    document.getElementById("summary").innerHTML = renderSummary(posts);
    document.getElementById("linkedin-cards-mount").innerHTML = renderLinkedinCards(savedSearches);
    document.getElementById("feed").innerHTML = renderFeed(posts);

    /* Footer dev-only details */
    const fSchema = document.getElementById("footer-schema");
    if (fSchema) fSchema.textContent = feed.schema_version || "";
    const fScoring = document.getElementById("footer-scoring");
    if (fScoring) fScoring.textContent = feed.scoring_version || "";
    const fGen = document.getElementById("footer-generated");
    if (fGen) fGen.textContent = generatedAt;

    /* Reapply filter (preserves slider/text value across re-renders) and tz formatting */
    applyFilter();
    applyTz();

    announce(`${posts.length} posts loaded`);
  }

  async function fetchAndRender() {
    try {
      /* cache: no-cache — revalidate but allow 304. The 10-min GH Pages
         max-age would otherwise serve stale on hard-reload chains. */
      const resp = await fetch("./feed.json", { cache: "no-cache" });
      if (!resp.ok) {
        renderError(`feed.json returned HTTP ${resp.status}`);
        return;
      }
      const feed = await resp.json();
      renderAll(feed);
    } catch (e) {
      renderError(e && e.message ? e.message : "Network error fetching feed.json");
    }
  }

  /* Auto-refresh open tabs. Cron fires every 15 min; jitter (0-30s) avoids
     simultaneously-open tabs dogpiling Fastly on the same wall-clock tick. */
  const REFRESH_MS = 15 * 60_000 + Math.floor(Math.random() * 30_000);
  setInterval(fetchAndRender, REFRESH_MS);

  /* Initial render. If the script is loaded after DOMContentLoaded already
     fired (defer guarantees parsing-after-DOM), fetch immediately. */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fetchAndRender);
  } else {
    fetchAndRender();
  }
})();
