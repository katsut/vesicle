// Shared top navigation: Sources / Sink / Pipelines / Model.
// Self-contained — injects its own markup and styles, styled through the CSS custom
// properties every page already defines (with fallbacks for pages that use different
// token names). Renders into #vnav when the page provides one (inside its topbar),
// otherwise prepends a standalone strip. Skips rendering entirely when the page is
// embedded in an iframe (pipeline.html inside pipelines.html / the wizard).
(() => {
  if (window.self !== window.top) return;

  const LABELS = {
    en: { nav_sources: "Sources", nav_sink: "Sink", nav_pipelines: "Pipelines", nav_model: "Model" },
    ja: { nav_sources: "ソース", nav_sink: "シンク", nav_pipelines: "パイプライン", nav_model: "モデル" },
    zh: { nav_sources: "数据源", nav_sink: "数据汇", nav_pipelines: "管道", nav_model: "模型" },
  };
  // [i18n key, href, pathnames that mark the item active]
  const ITEMS = [
    ["nav_sources", "/sources.html", ["/sources.html", "/connect", "/connect-backlog.html"]],
    ["nav_sink", "/sink.html", ["/sink.html"]],
    ["nav_pipelines", "/pipelines.html", ["/pipelines.html", "/pipeline.html", "/conformance", "/conformance.html"]],
    ["nav_model", "/model.html", ["/model.html", "/", "/wizard.html"]],
  ];

  function lang() {
    try { return localStorage.getItem("vesicle-lang") || "en"; } catch { return "en"; }
  }
  function label(key) {
    const d = LABELS[lang()] || LABELS.en;
    return d[key] || LABELS.en[key];
  }

  const style = document.createElement("style");
  style.textContent = `
.vnav{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.vnav a{font:600 12.5px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,sans-serif;letter-spacing:.02em;
  text-decoration:none;color:var(--mut,var(--muted,#8b8371));border:1px solid transparent;border-radius:100px;
  padding:7px 13px;transition:color .12s,background .12s,border-color .12s}
.vnav a:hover{color:var(--fg,#211d15)}
.vnav a.on{color:var(--accent,var(--earth,var(--mint,#2f9e73)));
  background:color-mix(in oklab,var(--accent,var(--earth,var(--mint,#2f9e73))) 15%,transparent);
  border-color:color-mix(in oklab,var(--accent,var(--earth,var(--mint,#2f9e73))) 42%,transparent)}
.vnav.bare{position:sticky;top:0;z-index:30;padding:10px clamp(14px,3vw,34px);
  border-bottom:1px solid var(--line,#e5dfd1);
  background:color-mix(in oklab,var(--bg,#f2efe6) 82%,transparent);backdrop-filter:blur(11px)}
@media (prefers-reduced-motion:reduce){.vnav a{transition:none}}`;
  document.head.appendChild(style);

  const nav = document.createElement("nav");
  nav.className = "vnav";
  nav.setAttribute("aria-label", "primary");
  const path = location.pathname;
  for (const [key, href, actives] of ITEMS) {
    const a = document.createElement("a");
    a.href = href;
    a.setAttribute("data-i18n", key); // pages with an i18n dict re-translate these live
    a.textContent = label(key);
    if (actives.includes(path)) a.classList.add("on");
    nav.appendChild(a);
  }

  const mount = document.getElementById("vnav");
  if (mount) mount.appendChild(nav);
  else { nav.classList.add("bare"); document.body.prepend(nav); }

  // cross-tab language changes (same-tab switches are handled by each page's own applyLang)
  window.addEventListener("storage", (e) => {
    if (e.key !== "vesicle-lang") return;
    nav.querySelectorAll("a[data-i18n]").forEach((a) => { a.textContent = label(a.getAttribute("data-i18n")); });
  });
})();
