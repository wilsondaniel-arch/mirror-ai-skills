const repoForm = document.querySelector("#repo-form");
const androidUrl = document.querySelector("#android-url");
const iosUrl = document.querySelector("#ios-url");
const androidBranch = document.querySelector("#android-branch");
const iosBranch = document.querySelector("#ios-branch");
const listButton = document.querySelector("#list-modules");
const byModuleEnum = document.querySelector("#by-module-enum");
const moduleGroups = document.querySelector("#module-groups");
const modulesStepTitle = document.querySelector("#modules-step-title");
const statusNode = document.querySelector("#status");
const errorNode = document.querySelector("#error");
const modulesStep = document.querySelector("#modules-step");
const modulesSource = document.querySelector("#modules-source");
const findDifferences = document.querySelector("#find-differences");
const refresh = document.querySelector("#refresh");
const refreshField = document.querySelector("#refresh-field");
const differencesStep = document.querySelector("#differences-step");
const downloadPdfButton = document.querySelector("#download-pdf");
const reportNode = document.querySelector("#report");
const exportNote = document.querySelector("#export-note");

const groups = [
  { list: document.querySelector("#common-list"), count: document.querySelector("#common-count"), key: "common" },
  { list: document.querySelector("#android-list"), count: document.querySelector("#android-count"), key: "androidOnly" },
  { list: document.querySelector("#ios-list"), count: document.querySelector("#ios-count"), key: "iosOnly" },
];

let sessionId = "";
let activeMode = "module";
// Declared before `applyLaunchParams()` runs below: a launch link starts an
// audit straight away, and these are read on that path.
let auditPoll = null;
/**
 * Bumped whenever the report on screen is replaced, so an export still waiting
 * on frames for an earlier report does not save the new one under its name.
 */
let reportRun = 0;
const MODE_KEY = "mirror-ai-comparison-mode";

if (byModuleEnum) {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(MODE_KEY) : null;
  if (saved === "repository") byModuleEnum.checked = false;
  byModuleEnum.addEventListener("change", () => {
    if (typeof localStorage !== "undefined") localStorage.setItem(MODE_KEY, comparisonMode());
    syncScopeUi();
    sessionId = "";
    hide(modulesStep);
    hide(differencesStep);
    reportNode.innerHTML = "";
    status("");
  });
  syncScopeUi();
}

function comparisonMode() {
  return byModuleEnum?.checked ? "module" : "repository";
}

function syncScopeUi() {
  const moduleScoped = comparisonMode() === "module";
  listButton.textContent = moduleScoped ? "List modules" : "Compare entire codebase";
  if (refreshField) {
    refreshField.hidden = moduleScoped && selectedModules().length === 0 && !sessionId;
    if (!moduleScoped) refreshField.hidden = false;
  }
}

repoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void listModules({
    androidUrl: androidUrl.value,
    iosUrl: iosUrl.value,
    androidBranch: androidBranch.value,
    iosBranch: iosBranch.value,
  });
});

/** Optional query params for Simple Browser: autostart repos, or watch an existing jobId. */
function applyLaunchParams() {
  if (typeof location === "undefined" || !location.search) return;
  const params = new URLSearchParams(location.search);
  const jobId = params.get("jobId");
  if (jobId) {
    void watchAuditJob(jobId);
    return;
  }
  if (params.get("mode") === "repository" && byModuleEnum) {
    byModuleEnum.checked = false;
    if (typeof localStorage !== "undefined") localStorage.setItem(MODE_KEY, "repository");
    syncScopeUi();
  }
  if (params.get("autostart") !== "1") return;
  const android = params.get("androidUrl");
  const ios = params.get("iosUrl");
  if (android) androidUrl.value = android;
  if (ios) iosUrl.value = ios;
  if (params.get("androidBranch")) androidBranch.value = params.get("androidBranch");
  if (params.get("iosBranch")) iosBranch.value = params.get("iosBranch");
  if (params.get("refresh") === "1" && refresh) refresh.checked = true;
  void listModules({
    androidUrl: androidUrl.value,
    iosUrl: iosUrl.value,
    androidBranch: androidBranch.value,
    iosBranch: iosBranch.value,
  });
}

applyLaunchParams();

async function watchAuditJob(jobId) {
  clearInterval(auditPoll);
  setBusy(true);
  clearError();
  hide(modulesStep);
  activeMode = "repository";
  const noun = "the full codebase";
  const started = Date.now();
  status(`Following audit ${jobId.slice(0, 8)}…`);
  const view = { drawn: new Set(), shots: false, reference: false };
  const pull = async () => {
    let latest;
    try {
      latest = await (await fetch(`/api/audits?${new URLSearchParams({ jobId })}`)).json();
    } catch {
      return;
    }
    if (!latest || latest.error) {
      setBusy(false);
      showError(latest?.error || "Lost track of the audit.");
      return;
    }
    if (!reportNode.querySelector("[data-pass]")) {
      reportNode.innerHTML = reportSkeleton(latest);
      show(differencesStep);
      differencesStep.scrollIntoView({ block: "start" });
    }
    drawAudit(latest, view, [], noun, started, true);
    updateDownloadPdfButton();
    if (!latest.done) auditPoll = setTimeout(() => void pull(), 2000);
  };
  await pull();
}

findDifferences.addEventListener("click", () => {
  void compare(comparisonMode() === "repository" ? [] : selectedModules());
});

if (downloadPdfButton) {
  downloadPdfButton.addEventListener("click", () => {
    void downloadReportPdf();
  });
}

function updateDownloadPdfButton() {
  if (!downloadPdfButton) return;
  const hasReport = reportNode.innerHTML.trim().length > 0 && !differencesStep.hidden;
  downloadPdfButton.hidden = !hasReport;
}

function pdfFileName() {
  const stamp = new Date().toISOString().slice(0, 10);
  const title = reportNode.querySelector("h1")?.textContent?.trim();
  const slug = title
    ? title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48)
    : "report";
  return `mirror-ai-${slug}-${stamp}.pdf`;
}

async function downloadReportPdf() {
  if (!downloadPdfButton || downloadPdfButton.hidden) return;
  const priorStatus = statusNode.textContent;
  downloadPdfButton.disabled = true;
  if (listButton) listButton.disabled = true;
  if (findDifferences) findDifferences.disabled = true;
  status("Building PDF from the report on screen…");
  try {
    const filename = pdfFileName();
    const response = await fetch("/api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: await printableReportHtml(), title: filename.replace(/\.pdf$/, "") }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      // No Chrome on the server (or a server from before /api/pdf): the
      // browser's own dialog prints with the same print stylesheet, and
      // "Save as PDF" gives the same file.
      if (payload.fallback === "print" || response.status === 404) {
        status(priorStatus);
        window.print();
        return;
      }
      throw new Error(payload.error || "The PDF could not be created.");
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    status(priorStatus);
  } catch (error) {
    showError(error instanceof Error ? error.message : "The PDF could not be created.");
    status("");
  } finally {
    downloadPdfButton.disabled = false;
    if (listButton) listButton.disabled = false;
    if (findDifferences) findDifferences.disabled = false;
  }
}

/**
 * The report as drawn, with collapsed parts opened and every frame embedded,
 * so the copy stands on its own: frame URLs are tied to this session, which
 * the saved file outlives.
 */
async function printableReportHtml() {
  const copy = reportNode.cloneNode(true);
  for (const details of copy.querySelectorAll("details")) details.open = true;
  await Promise.all(
    [...copy.querySelectorAll("img[src]")].map(async (img) => {
      try {
        img.setAttribute("src", await dataUrl(img.getAttribute("src")));
      } catch {
        // A frame that cannot be fetched stays a link; the rest still saves.
      }
    }),
  );
  return copy.innerHTML;
}

async function dataUrl(src) {
  const blob = await (await fetch(src)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Every finished report is kept as an HTML file and a PDF without anyone
 * asking. It waits for the frame renders, since those belong in the copy.
 */
async function autoExportReport(view) {
  const run = reportRun;
  await view.shotsSettled;
  if (run !== reportRun || !exportNote) return;
  exportNote.hidden = false;
  exportNote.textContent = "Saving this report as HTML and PDF…";
  const html = await printableReportHtml();
  if (run !== reportRun) return;
  const saved = await post("/api/exports", { html, title: pdfFileName().replace(/\.pdf$/, "") });
  if (run !== reportRun) return;
  if (!saved || saved.error) {
    exportNote.textContent = `The report could not be saved: ${saved?.error || "no reply from the server"}.`;
    return;
  }
  const links = [`<a href="${escapeHtml(saved.htmlUrl)}" target="_blank" rel="noopener">HTML</a>`];
  if (saved.pdfUrl) links.push(`<a href="${escapeHtml(saved.pdfUrl)}" target="_blank" rel="noopener">PDF</a>`);
  const folder = saved.html.replace(/[^/\\]+$/, "");
  exportNote.innerHTML = `${saved.reused ? "Already saved" : "Saved"}: ${links.join(" · ")} — in <code>${escapeHtml(folder)}</code>${
    saved.pdf ? "" : `. No PDF: ${escapeHtml(saved.pdfError || "it could not be printed")}`
  }`;
}

function clearExportNote() {
  reportRun += 1;
  if (!exportNote) return;
  exportNote.hidden = true;
  exportNote.textContent = "";
}

async function listModules(body) {
  setBusy(true);
  clearError();
  hide(modulesStep);
  hide(differencesStep);
  reportNode.innerHTML = "";
  clearExportNote();
  updateDownloadPdfButton();
  const mode = comparisonMode();
  status(
    mode === "module"
      ? "Reading both repositories and finding their module enums…"
      : "Reading both repositories for a full-codebase comparison…",
  );
  const payload = await post("/api/modules", { ...body, mode });
  if (!payload || payload.error) {
    setBusy(false);
    status("");
    showError(payload?.error || "Could not read the modules.");
    return;
  }
  sessionId = payload.sessionId;
  activeMode = payload.mode === "repository" ? "repository" : "module";
  const repositoryScoped = activeMode === "repository";
  if (repositoryScoped) {
    hide(modulesStep);
    await compare([]);
    return;
  }
  setBusy(false);
  if (moduleGroups) moduleGroups.hidden = false;
  if (modulesStepTitle) modulesStepTitle.textContent = "Modules";
  modulesSource.textContent = sourceLine(payload);
  for (const group of groups) renderGroup(group, payload[group.key] || []);
  show(modulesStep);
  updateFindButton();
  const total = groups.reduce((sum, group) => sum + (payload[group.key] || []).length, 0);
  status(
    `${total} modules · ${payload.common?.length || 0} common · ${payload.androidOnly?.length || 0} Android only · ${payload.iosOnly?.length || 0} iOS only.`,
  );
  modulesStep.scrollIntoView({ block: "start" });
}

/**
 * Each module's sections are separate runs. The page lays out a slot for every
 * one, starts them all, and fills each slot the moment its run finishes, so the
 * business logic can be read while the UI and API sections are still working.
 */
async function compare(modules) {
  const repositoryScoped = activeMode === "repository";
  if (!repositoryScoped && modules.length === 0) return;
  clearInterval(auditPoll);
  setBusy(true);
  clearError();
  const noun = repositoryScoped ? "the full codebase" : `${modules.length} module${modules.length === 1 ? "" : "s"}`;
  const started = Date.now();
  status(`Starting the audit of ${noun}…`);
  const job = await post("/api/audits", {
    sessionId,
    modules,
    mode: activeMode,
    refresh: refresh.checked,
  });
  if (!job || job.error) {
    setBusy(false);
    status("");
    showError(job?.error || "The audit could not start.");
    return;
  }
  reportNode.innerHTML = reportSkeleton(job);
  clearExportNote();
  show(differencesStep);
  updateDownloadPdfButton();
  differencesStep.scrollIntoView({ block: "start" });
  const view = { drawn: new Set(), shots: false, reference: false, exported: false };
  drawAudit(job, view, modules, noun, started, repositoryScoped);
  updateDownloadPdfButton();
  if (job.done) return;
  auditPoll = setInterval(async () => {
    let latest;
    try {
      latest = await (await fetch(`/api/audits?${new URLSearchParams({ jobId: job.id })}`)).json();
    } catch {
      return;
    }
    if (!latest || latest.error) {
      clearInterval(auditPoll);
      setBusy(false);
      showError(latest?.error || "Lost track of the audit.");
      return;
    }
      drawAudit(latest, view, modules, noun, started, repositoryScoped);
    updateDownloadPdfButton();
  }, 2000);
}

function reportSkeleton(job) {
  return job.modules
    .map(
      (module, m) =>
        `${m > 0 ? "<hr />" : ""}<h1>${escapeHtml(module.heading.replace(/^#\s*/, ""))}</h1>${module.passes
          .map((_, p) => `<section class="pass" data-pass="${m}-${p}" data-module="${escapeHtml(module.key)}"></section>`)
          .join("")}`,
    )
    .join("");
}

function drawAudit(job, view, modules, noun, started, repositoryScoped = false) {
  job.modules.forEach((module, m) => {
    module.passes.forEach((pass, p) => {
      const key = `${m}-${p}`;
      if (view.drawn.has(key)) return;
      const slot = reportNode.querySelector(`[data-pass="${key}"]`);
      if (!slot) return;
      if (pass.markdown == null) {
        slot.innerHTML = pendingPass(pass);
        return;
      }
      view.drawn.add(key);
      slot.className = `pass pass-${pass.state}`;
      slot.innerHTML = savedNote(pass) + renderMarkdown(uiOnly(matrixOnly(pass.markdown)));
      attachLayouts(slot);
      linkCitations(slot);
    });
  });
  const finished = (pass) => pass.markdown != null;
  // Frames go above the UI section, so they wait for it to arrive.
  if (
    !repositoryScoped &&
    !view.shots &&
    (reportNode.querySelector(".pass-done h3") || job.done)
  ) {
    const ui = [...reportNode.querySelectorAll("h3")].some((heading) => /UI Difference/i.test(heading.textContent));
    if (ui || job.done) {
      view.shots = true;
      view.shotsSettled = showScreenshots(modules);
    }
  }
  if (job.done) {
    clearInterval(auditPoll);
    setBusy(false);
    const summary = job.modules.map((module) => ({
      cached: module.passes.every((pass) => pass.cached),
      at: module.passes.map((pass) => pass.at).filter(Boolean).sort()[0],
    }));
    status(auditSummary(summary, noun, started));
    updateDownloadPdfButton();
    if (!view.exported) {
      view.exported = true;
      void autoExportReport(view);
    }
    return;
  }
  status(`${progressLine(job)} — ${elapsed(started)} so far. Each section appears as soon as it is ready.`);
  updateDownloadPdfButton();
}

/**
 * Section 2 shows the differences and nothing else: any prose the audit writes
 * around the matrix — an intro, a list of regression tests — is dropped. A
 * section with no table (a one-line "no differences") is left as written.
 */
function matrixOnly(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^\s*###\s+2\.\s/.test(line));
  if (start < 0) return markdown;
  let end = lines.findIndex((line, at) => at > start && /^\s*#{1,3}\s/.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  const from = body.findIndex((line, at) => isTableRow(line) && isTableDivider(body[at + 1]));
  if (from < 0) return markdown;
  let to = from;
  while (to < body.length && isTableRow(body[to])) to += 1;
  return [...lines.slice(0, start + 1), "", ...body.slice(from, to), "", ...lines.slice(end)].join("\n");
}

/**
 * Section 3 keeps its heading, the per-screen table, and each screen's
 * slot-by-slot layout cut down to its divergent rows. The intro, the coverage
 * table and the notes are dropped, and so is a layout with nothing divergent.
 */
function uiOnly(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^\s*###\s+3\.\s/.test(line));
  if (start < 0) return markdown;
  let end = lines.findIndex((line, at) => at > start && /^\s*###\s+\d+\.\s/.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  const tableAt = (at) => isTableRow(body[at]) && isTableDivider(body[at + 1]);
  const tableEnd = (at) => {
    while (at < body.length && isTableRow(body[at])) at += 1;
    return at;
  };
  const from = body.findIndex((line, at) => tableAt(at) && /android elements/i.test(line));
  if (from < 0) return markdown;
  const kept = [...body.slice(from, tableEnd(from)), ""];
  for (let at = 0; at < body.length; at += 1) {
    const title = /^\s*\*\*(UI-\d+\b[^*]*)\*\*\s*$/.exec(body[at]);
    if (!title) continue;
    const table = body.findIndex((line, next) => next > at && tableAt(next));
    if (table < 0 || !/\|\s*slot\s*\|/i.test(body[table])) continue;
    const header = splitRow(body[table]).map((cell) => cell.toLowerCase());
    const state = header.indexOf("state");
    const rows = body
      .slice(table + 2, tableEnd(table))
      .filter((row) => (splitRow(row)[state] || "").toLowerCase().replace(/[^a-z]/g, "") === "divergent");
    if (rows.length === 0) continue;
    kept.push(`#### ${title[1].trim()}`, "", body[table], body[table + 1], ...rows, "");
  }
  return [...lines.slice(0, start + 1), "", ...kept, ...lines.slice(end)].join("\n");
}

/** Moves each screen's divergent-slot layout under that screen's card, matched by its UI id. */
function attachLayouts(root) {
  for (const heading of root.querySelectorAll("h4")) {
    const id = /^UI-\d+/.exec(heading.textContent.trim())?.[0];
    const layout = heading.nextElementSibling;
    if (!id || !layout?.classList.contains("layout")) continue;
    const card = root.querySelector(`article.ui-diff[data-id="${id}"]`);
    if (card) card.append(heading, layout);
  }
}

/** A section replayed from disk says when it was produced, so nobody mistakes it for a fresh run. */
function savedNote(pass) {
  if (!pass.cached) return "";
  const when = pass.at ? new Date(pass.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
  return `<p class="pass-saved">${escapeHtml(pass.title)} · from saved report${when ? ` of ${escapeHtml(when)}` : ""}</p>`;
}

function pendingPass(pass) {
  const running = pass.state === "running";
  const note = running
    ? `Running for ${elapsed(pass.startedAt)}. It appears here as soon as it is ready — usually several minutes.`
    : "Waiting for a free slot; it starts when an earlier section finishes.";
  return `<div class="pass-pending${running ? " running" : ""}"><span class="spinner" aria-hidden="true"></span><div><strong>${
    running ? "Calculating" : "Queued:"
  } ${escapeHtml(pass.title)}</strong><p>${note}</p></div></div>`;
}

/** "Business logic ready · UI Difference running · API Contract Drift queued", counted across modules. */
function progressLine(job) {
  const titles = [...new Set(job.modules.flatMap((module) => module.passes.map((pass) => pass.title)))];
  return titles
    .map((title) => {
      const passes = job.modules.flatMap((module) => module.passes.filter((pass) => pass.title === title));
      const ready = passes.filter((pass) => pass.markdown != null).length;
      if (ready === passes.length) return `${title} ready`;
      const word = passes.some((pass) => pass.state === "running") ? "running" : "queued";
      return passes.length === 1 ? `${title} ${word}` : `${title} ${ready}/${passes.length}`;
    })
    .join(" · ");
}

/**
 * Rendered frames, where any exist, go above the UI section so the reader sees
 * the screens before reading what differs between them. A module missing
 * frames on either platform is rendered in the background, and the gallery
 * fills in as each render finishes.
 */
let renderPoll = null;

async function showScreenshots(modules) {
  clearInterval(renderPoll);
  await drawGallery(modules, []);
  const started = await post("/api/render", { sessionId, modules }).catch(() => null);
  const jobs = started?.jobs ?? [];
  await drawGallery(modules, jobs);
  if (!jobs.some(renderActive)) return;
  const query = new URLSearchParams({ sessionId });
  for (const module of modules) query.append("module", module);
  // Settles when the last render finishes, so the saved copy can include it.
  return new Promise((resolve) => {
    renderPoll = setInterval(async () => {
      let payload;
      try {
        payload = await (await fetch(`/api/render?${query}`)).json();
      } catch {
        return;
      }
      const latest = payload?.jobs ?? [];
      await drawGallery(modules, latest);
      if (!latest.some(renderActive)) {
        clearInterval(renderPoll);
        resolve();
      }
    }, 5000);
  });
}

function renderActive(job) {
  return [job.android.state, job.ios.state].some((state) => state === "queued" || state === "running");
}

async function drawGallery(modules, jobs) {
  const cards = [...reportNode.querySelectorAll("article.ui-diff")];
  if (cards.length === 0) return;
  const query = new URLSearchParams({ sessionId });
  for (const module of modules) query.append("module", module);
  let payload;
  try {
    payload = await (await fetch(`/api/screenshots?${query}`)).json();
  } catch {
    return;
  }
  const notes = { android: renderNote(jobs, "android"), ios: renderNote(jobs, "ios") };
  // Each frame goes to the one differing screen it shows; a frame that shows
  // none of them is not drawn.
  const placed = new Map(cards.map((card) => [card, []]));
  for (const shot of payload?.shots ?? []) {
    const candidates = cards.filter((card) => card.closest("section.pass")?.dataset.module === shot.module);
    let best = null;
    let bestScore = 0;
    for (const card of candidates) {
      const score = shotScore(shot, card);
      if (score > bestScore) {
        best = card;
        bestScore = score;
      }
    }
    if (best) placed.get(best).push(shot);
  }
  // A screen with no frame shows no box, unless a render is still under way.
  const rendering = jobs.some(renderActive);
  for (const [card, shots] of placed) {
    const box = card.querySelector(".ui-shots");
    box.hidden = shots.length === 0 && !rendering;
    box.innerHTML = box.hidden ? "" : `<section class="shots">${shotColumns(shots, notes)}</section>`;
  }
}

const SCREEN_SUFFIX = /(bottomsheet|screen|view|sheet|dialog|content|destination|route|previews?)+$/;
const FRAME_FILLER = new Set(["screen", "preview", "view", "route", "sheet", "state", "figma", "the", "and", "for", "with"]);

/** `BillHistoryScreen` and `BillHistoryRoute` both reduce to `billhistory`. */
function screenCore(identifier) {
  return identifier.toLowerCase().replace(SCREEN_SUFFIX, "");
}

function frameWords(text) {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word.length > 2 && !FRAME_FILLER.has(word));
}

/**
 * How surely a frame shows this screen, 0 for not at all. A frame is compared
 * with its own platform's side of the screen name and the files the row cites
 * for that platform: the source file it was rendered from first, its name
 * second.
 */
function shotScore(shot, card) {
  const [androidSide, iosSide = ""] = card.dataset.screen.split("↔");
  const side = shot.platform === "android" ? androidSide : iosSide;
  const cited = (card.dataset.biggest.match(shot.platform === "android" ? /[\w-]+\.kt\b/g : /[\w-]+\.swift\b/g) || []).map(
    (file) => file.replace(/\.\w+$/, ""),
  );
  const identifiers = [...(side.match(/[A-Za-z][A-Za-z0-9]{5,}/g) || []), ...cited];
  if (shot.source) {
    const stem = shot.source.split("/").pop().replace(/\.\w+$/, "");
    if (identifiers.some((id) => id.toLowerCase() === stem.toLowerCase())) return 10;
    const core = screenCore(stem);
    if (core.length >= 6 && identifiers.some((id) => screenCore(id) === core)) return 8;
    if (core.length >= 6 && identifiers.some((id) => {
      const other = screenCore(id);
      return other.length >= 6 && (other.includes(core) || core.includes(other));
    })) return 5;
  }
  const words = frameWords(shot.file.replace(/\.\w+$/, ""));
  if (words.length === 0) return 0;
  const sideWords = new Set(frameWords(side));
  const hits = words.filter((word) => sideWords.has(word)).length;
  return hits >= 2 && hits / words.length >= 2 / 3 ? hits / words.length : 0;
}

/** What the render queue says about one platform, or "" when there is nothing to add. */
function renderNote(jobs, platform) {
  const states = jobs.map((job) => job[platform]);
  if (states.some((job) => job.state === "running")) return "Rendering now — this takes a few minutes.";
  if (states.some((job) => job.state === "queued")) return "Waiting to render.";
  const failed = states.find((job) => job.state === "failed");
  return failed ? `Could not render: ${failed.error}` : "";
}

function shotColumns(shots, notes) {
  return ["android", "ios"]
    .map((platform) => {
      const mine = shots.filter((shot) => shot.platform === platform);
      const label = platform === "android" ? "Android" : "iOS";
      const note = notes[platform] ? `<p class="shot-none">${escapeHtml(notes[platform])}</p>` : "";
      if (mine.length === 0) {
        return `<div class="shot-col"><h5>${label}</h5>${note || '<p class="shot-none">No rendered frame yet.</p>'}</div>`;
      }
      const figures = mine
        .map((shot) => {
          const src = `/api/screenshot?${new URLSearchParams({
            sessionId,
            module: shot.module,
            platform,
            file: shot.file,
          })}`;
          return `<figure><img src="${src}" alt="${escapeHtml(shot.name)}" loading="lazy" /><figcaption>${escapeHtml(shot.name)}</figcaption></figure>`;
        })
        .join("");
      return `<div class="shot-col"><h5>${label}</h5>${note}<div class="shot-strip">${figures}</div></div>`;
    })
    .join("");
}

// A citation is a repo-relative path plus a line or line range. The path may be
// abbreviated with an ellipsis, which the server resolves by matching the tail.
const CITATION = /((?:[\w.$-]+|\.\.\.)(?:\/(?:[\w.$-]+|\.\.\.))*\.(?:kt|kts|java|swift)):(\d+)(?:\s*[-–]\s*(\d+))?/g;

/** Turns every file:line in the rendered report into a button that opens the code. */
function linkCitations(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement.closest(".preview, .code-block, a, button")) continue;
    if (CITATION.test(node.nodeValue)) texts.push(node);
    CITATION.lastIndex = 0;
  }
  for (const node of texts) replaceCitations(node);
}

function replaceCitations(node) {
  const text = node.nodeValue;
  const fragment = document.createDocumentFragment();
  let at = 0;
  CITATION.lastIndex = 0;
  for (let match = CITATION.exec(text); match; match = CITATION.exec(text)) {
    if (match.index > at) fragment.append(text.slice(at, match.index));
    fragment.append(citationButton(match[0], match[1], match[2], match[3]));
    at = match.index + match[0].length;
  }
  if (at < text.length) fragment.append(text.slice(at));
  node.parentNode.replaceChild(fragment, node);
}

function citationButton(label, file, start, end) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "citation";
  button.textContent = label;
  // Only iOS is written in Swift, so the extension says which checkout to read.
  button.dataset.side = /\.swift$/.test(file) ? "ios" : "android";
  button.dataset.file = file;
  button.dataset.start = start;
  button.dataset.end = end || start;
  button.addEventListener("click", () => togglePreview(button));
  return button;
}

async function togglePreview(button) {
  const open = button.nextElementSibling;
  if (open?.classList.contains("preview")) {
    open.remove();
    button.classList.remove("open");
    return;
  }
  button.classList.add("open");
  const preview = document.createElement("div");
  preview.className = "preview";
  preview.textContent = "Loading…";
  button.after(preview);
  const query = new URLSearchParams({
    sessionId,
    side: button.dataset.side,
    file: button.dataset.file,
    start: button.dataset.start,
    end: button.dataset.end,
  });
  let payload;
  try {
    payload = await (await fetch(`/api/source?${query}`)).json();
  } catch {
    payload = { error: "The page could not reach the local server." };
  }
  if (payload.error) {
    preview.className = "preview preview-error";
    preview.textContent = payload.error;
    return;
  }
  preview.innerHTML = `<header>${escapeHtml(payload.file)}<span>lines ${payload.focusStart}–${payload.focusEnd}</span></header>${payload.html}`;
  // Shiki emits one .line per row; the counter makes them show real line numbers.
  const code = preview.querySelector("code");
  if (code) code.style.counterReset = `line ${payload.start - 1}`;
}

/** Says plainly which modules were replayed from disk and which were audited. */
function auditSummary(modules, noun, started) {
  const replayed = (modules || []).filter((module) => module.cached);
  if (replayed.length === 0) return `Audit of ${noun} finished in ${elapsed(started)}.`;
  if (replayed.length === (modules || []).length) {
    const when = replayed.length === 1 && replayed[0].at ? ` from ${replayed[0].at.slice(0, 10)}` : "";
    return `${noun} shown from saved report${replayed.length === 1 ? "" : "s"}${when} — nothing was re-audited. Tick the box above to run again.`;
  }
  const fresh = (modules || []).length - replayed.length;
  return `${replayed.length} of ${noun} from saved reports, ${fresh} audited in ${elapsed(started)}.`;
}

function elapsed(started) {
  const seconds = Math.round((Date.now() - started) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function renderGroup(group, rows) {
  group.list.innerHTML = "";
  group.count.textContent = rows.length;
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint empty";
    empty.textContent = "None.";
    group.list.append(empty);
    return;
  }
  for (const row of rows) {
    const domId = `module-${group.key}-${row.key}`;
    const label = document.createElement("label");
    label.className = "module";
    label.htmlFor = domId;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = domId;
    box.value = row.key;
    box.addEventListener("change", updateFindButton);
    const name = document.createElement("span");
    name.className = "module-name";
    name.textContent = row.label;
    const where = document.createElement("span");
    where.className = "module-where";
    where.textContent = row.id;
    where.title = [sideText("Android", row.android), sideText("iOS", row.ios)].filter(Boolean).join("\n");
    label.append(box, name, where);
    group.list.append(label);
  }
}

function sideText(platform, side) {
  if (!side) return "";
  return `${platform}: ${side.enumName}.${side.caseName} — ${side.file}:${side.line}`;
}

function sourceLine(payload) {
  const parts = [];
  if (payload.androidSource) {
    parts.push(`Android ${payload.androidSource.enumName} (${payload.androidSource.file})`);
  }
  if (payload.iosSource) {
    parts.push(`iOS ${payload.iosSource.enumName} (${payload.iosSource.file})`);
  }
  return parts.length > 0 ? `Read from ${parts.join(" and ")}.` : "";
}

function selectedModules() {
  return [...modulesStep.querySelectorAll("input[type=checkbox]:checked")].map((box) => box.value);
}

function updateFindButton() {
  if (comparisonMode() === "repository") {
    if (refreshField) refreshField.hidden = false;
    return;
  }
  const count = selectedModules().length;
  findDifferences.hidden = count === 0;
  if (refreshField) refreshField.hidden = count === 0;
  findDifferences.textContent = count === 0 ? "Find differences" : `Find differences (${count})`;
}

async function post(url, body) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await response.json();
  } catch {
    return { error: "The page could not reach the local server." };
  }
}

/**
 * Renders the audit report: headings, tables, lists, fenced code, blockquotes,
 * rules, bold and inline code. Everything is escaped before any tag is added.
 */
function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push(renderCodeBlock(code.join("\n"), fence[1]));
      continue;
    }
    if (isTableRow(line) && isTableDivider(lines[index + 1])) {
      const rows = [];
      while (index < lines.length && isTableRow(lines[index])) {
        rows.push(lines[index]);
        index += 1;
      }
      html.push(renderTable(rows));
      continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      html.push("<hr />");
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }
    const bullet = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const items = [];
      while (index < lines.length) {
        const next = /^\s*([-*+]|\d+\.)\s+(.*)$/.exec(lines[index]);
        if (!next || /\d/.test(next[1]) !== ordered) break;
        items.push(`<li>${inline(next[2])}</li>`);
        index += 1;
      }
      html.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index], lines[index + 1])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }
  return html.join("");
}

function isBlockStart(line, next) {
  return (
    /^\s*```/.test(line) ||
    /^\s*(#{1,6})\s+/.test(line) ||
    /^\s*([-*+]|\d+\.)\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*(---+|\*\*\*+|___+)\s*$/.test(line) ||
    (isTableRow(line) && isTableDivider(next))
  );
}

function isTableRow(line) {
  return typeof line === "string" && /^\s*\|.*\|\s*$/.test(line);
}

function isTableDivider(line) {
  return typeof line === "string" && /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes("-");
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const MATRIX_COLUMNS = ["android behavior", "ios behavior", "severity"];
const API_COLUMNS = ["api", "android calls", "ios calls", "verdict"];
const UI_COLUMNS = ["screen", "android elements", "ios elements", "matched", "divergent"];
const LAYOUT_COLUMNS = ["slot", "type", "android", "ios", "state"];
/** Slot types the wireframe knows how to draw; anything else falls back to a box. */
const SLOT_GLYPH = {
  appbar: "▭", title: "T", text: "¶", button: "▬", link: "↗", input: "▢",
  toggle: "◉", image: "▣", icon: "◆", list: "☰", row: "▭", sheet: "⌃",
  dialog: "▢", state: "◌", spacer: " ",
};
/** Every verdict the api-skill may return that is not simply "Necessary". */
const API_PROBLEMS = new Set([
  "duplicate",
  "redundant",
  "discarded",
  "eager",
  "uncapped retry",
  "re-entrant render",
  "no in-flight guard",
  "unbounded fan-out",
  "unbounded paging",
  "undebounced input",
  "timer or poll",
  "racing responses",
]);

function renderTable(rows) {
  const head = splitRow(rows[0]);
  const body = rows.slice(2).map(splitRow);
  const keys = head.map((cell) => cell.toLowerCase().replace(/[^a-z ]/g, "").trim());
  // Seven columns of prose do not fit a table at screen width, so the
  // difference matrix becomes one card per finding instead.
  if (MATRIX_COLUMNS.every((column) => keys.includes(column))) {
    // Only High findings are shown.
    const severity = keys.indexOf("severity");
    const high = body.filter((cells) => rank(cells[severity] || "") === "high");
    if (high.length === 0) return `<p class="matrix-hidden">No High differences.</p>`;
    return high.map((cells) => renderFinding(keys, cells)).join("");
  }
  if (API_COLUMNS.every((column) => keys.includes(column))) {
    return body.map((cells) => renderApiCall(keys, cells)).join("");
  }
  // The UI table is scored as a whole: the module total pools every paired row,
  // so this branch cannot map rows independently like the two above.
  if (UI_COLUMNS.every((column) => keys.includes(column))) {
    return renderUiTable(keys, body);
  }
  // The layout view is drawn as two stacked columns, not a table, so the two
  // screens read side by side the way they appear on a device.
  if (LAYOUT_COLUMNS.every((column) => keys.includes(column))) {
    return renderLayout(keys, body);
  }
  const headHtml = head.map((cell) => `<th>${inline(cell)}</th>`).join("");
  const bodyHtml = body
    .map((cells) => `<tr>${cells.map((cell, at) => `<td>${renderCell(keys[at], cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

/** Same colour for the same contract value or drift tag everywhere, as on the drift canvas. */
const CONTRACT_CHIP = {
  same: "same",
  drift: "drift",
  "android only": "android",
  "a only": "android",
  "ios only": "ios",
};
const DRIFT_TAGS = new Set(["BODY", "HDR", "ROUTE", "TYPE", "CASE", "HOST"]);

function renderCell(key, cell) {
  if (key === "contract" || key === "status") {
    const kind = CONTRACT_CHIP[cell.replace(/\*\*/g, "").trim().toLowerCase()];
    if (kind) return `<span class="badge contract-${kind}">${escapeHtml(cell.replace(/\*\*/g, "").trim())}</span>`;
  }
  if (key === "drift" || key === "tag") {
    const tags = cell.split(",").map((tag) => tag.replace(/`/g, "").trim());
    if (tags.length > 0 && tags.every((tag) => DRIFT_TAGS.has(tag))) {
      return tags.map((tag) => `<span class="badge drift-${tag.toLowerCase()}">${tag}</span>`).join(" ");
    }
  }
  return inline(cell);
}

function renderFinding(keys, cells) {
  const cell = (name) => {
    const value = cells[keys.indexOf(name)];
    return value && value !== "-" ? value : "";
  };
  const severity = cell("severity");
  const confidence = cell("confidence");
  const impact = cell("business impact");
  const badges = [
    severity ? `<span class="badge sev-${rank(severity)}">${inline(severity)}</span>` : "",
    confidence ? `<span class="badge confidence">${inline(confidence)}</span>` : "",
  ].join("");
  const sides = [
    ["Android", cell("android behavior")],
    ["iOS", cell("ios behavior")],
  ]
    .map(
      ([platform, text]) =>
        `<section class="side"><h4>${platform}</h4><p>${text ? inline(text) : "<em>Nothing on this side.</em>"}</p></section>`,
    )
    .join("");
  const impactHtml = impact ? `<p class="impact"><strong>Impact</strong> ${inline(impact)}</p>` : "";
  return `<article class="finding sev-${rank(severity)}">
    <header><span class="finding-id">${inline(cell("id") || "—")}</span><h3>${inline(cell("business area"))}</h3>${badges}</header>
    <div class="sides">${sides}</div>${impactHtml}
  </article>`;
}

function renderApiCall(keys, cells) {
  const cell = (name) => {
    const value = cells[keys.indexOf(name)];
    return value && value !== "-" ? value : "";
  };
  const verdict = cell("verdict");
  const problem = API_PROBLEMS.has(verdict.toLowerCase());
  const worst = cell("worst case");
  const unbounded = /unbounded|\bn\b|per keystroke|forever|unlimited/i.test(worst);
  const meta = [
    cell("trigger") ? `<p><strong>Trigger</strong> ${inline(cell("trigger"))}</p>` : "",
    worst
      ? `<p><strong>Worst case</strong> <span class="worst${unbounded ? " unbounded" : ""}">${inline(worst)}</span></p>`
      : "",
    cell("risk") ? `<p><strong>${problem ? "Risk" : "Bounded by"}</strong> ${inline(cell("risk"))}</p>` : "",
  ].join("");
  const sides = [
    ["Android", cell("android calls")],
    ["iOS", cell("ios calls")],
  ]
    .map(([platform, text]) => {
      const missing = !text || /^not called/i.test(text);
      return `<section class="side${missing ? " side-none" : ""}"><h4>${platform}</h4><p>${
        text ? inline(text) : "<em>Not called.</em>"
      }</p></section>`;
    })
    .join("");
  return `<article class="finding api-call${problem ? " api-problem" : " api-ok"}">
    <header><span class="finding-id">${inline(cell("id") || "—")}</span><h3><code>${escapeHtml(cell("api"))}</code></h3><span class="badge ${problem ? "verdict-problem" : "verdict-ok"}">${inline(verdict || "—")}</span></header>
    <div class="sides">${sides}</div>
    <div class="api-meta">${meta}</div>
  </article>`;
}

/**
 * The skill publishes four integers per screen and no percentage; every figure
 * below is derived here, so there is one source of truth for the arithmetic.
 *
 *   union U = A + I - M   distinct slots across both platforms
 *   same  S = M - D       slots present on both and in agreement
 *   diff    = U - S       = (A-M) + (I-M) + D
 */
function uiScore(keys, cells) {
  const cell = (name) => (cells[keys.indexOf(name)] ?? "").trim();
  const count = (name) => {
    const raw = cell(name);
    // "~12" and "12 or so" are not counts. Never coerce them into one.
    return /^\d+$/.test(raw) ? Number(raw) : NaN;
  };
  const a = count("android elements");
  const i = count("ios elements");
  const m = count("matched");
  const d = count("divergent");
  const union = a + i - m;
  const valid =
    [a, i, m, d].every(Number.isInteger) &&
    [a, i, m, d].every((value) => value >= 0) &&
    m <= Math.min(a, i) &&
    d <= m &&
    union > 0;
  // Derived from the counts, not the Pairing label: a label spelled "Many to
  // one" or left blank must not silently drop a screen out of the total.
  const paired = valid && a > 0 && i > 0;
  const diff = valid ? union - (m - d) : 0;
  return {
    a,
    i,
    m,
    d,
    union: valid ? union : 0,
    diff,
    pct: valid ? (100 * diff) / union : 0,
    pairing: cell("pairing"),
    paired,
    valid,
  };
}

/**
 * Section 3 shows only the screens that differ: each one's screenshots, then
 * its name and its biggest difference. Screens that agree are left out.
 */
function renderUiTable(keys, body) {
  const differing = body.filter((cells) => {
    const score = uiScore(keys, cells);
    return score.valid && (!score.paired || score.diff > 0);
  });
  if (differing.length === 0) return `<p class="matrix-hidden">No screen differs.</p>`;
  return differing.map((cells) => renderUiDiff(keys, cells)).join("");
}

function renderUiDiff(keys, cells) {
  const cell = (name) => {
    const value = cells[keys.indexOf(name)];
    return value && value !== "-" ? value : "";
  };
  const screen = cell("screen");
  const biggest = cell("largest difference");
  return `<article class="ui-diff" data-id="${escapeHtml(cell("id"))}" data-screen="${escapeHtml(screen)}" data-biggest="${escapeHtml(biggest)}">
    <div class="ui-shots" hidden></div>
    <h3>${inline(screen)}</h3>
    ${biggest ? `<p><strong>Biggest</strong> ${inline(biggest)}</p>` : ""}
  </article>`;
}

/**
 * Draws a screen's slots as two aligned columns — a reconstruction from the
 * source, not a screenshot, which the caption says plainly.
 */
function renderLayout(keys, body) {
  const at = (cells, name) => (cells[keys.indexOf(name)] ?? "").trim();
  const rows = body.map((cells) => {
    const state = at(cells, "state").toLowerCase().replace(/[^a-z]/g, "");
    return {
      slot: at(cells, "slot"),
      type: at(cells, "type").toLowerCase(),
      android: at(cells, "android"),
      ios: at(cells, "ios"),
      state:
        state === "same" ? "same"
        : state === "divergent" ? "divergent"
        : state === "androidonly" ? "android-only"
        : state === "iosonly" ? "ios-only"
        : "same",
    };
  });
  const differing = rows.filter((row) => row.state !== "same").length;
  const side = (row, platform) => {
    const text = platform === "android" ? row.android : row.ios;
    const absent = !text || text === "—" || text === "-";
    const missing =
      (platform === "android" && row.state === "ios-only") ||
      (platform === "ios" && row.state === "android-only");
    return `<div class="slot slot-${row.state}${absent || missing ? " slot-absent" : ""}">
      <span class="slot-glyph">${escapeHtml(SLOT_GLYPH[row.type] ?? "▭")}</span>
      <span class="slot-text">${absent ? "<em>not here</em>" : inline(text)}</span>
    </div>`;
  };
  const labels = rows
    .map(
      (row) =>
        `<div class="slot-label slot-${row.state}"><span>${inline(row.slot)}</span><span class="slot-type">${escapeHtml(row.type)}</span></div>`,
    )
    .join("");
  return `<div class="layout">
    <header><span>Reconstructed from source — not a screenshot</span><span>${differing} slot${differing === 1 ? "" : "s"} differ${differing === 1 ? "s" : ""}</span></header>
    <div class="layout-grid">
      <div class="layout-col layout-labels"><h5>Slot</h5>${labels}</div>
      <div class="layout-col"><h5>Android</h5>${rows.map((row) => side(row, "android")).join("")}</div>
      <div class="layout-col"><h5>iOS</h5>${rows.map((row) => side(row, "ios")).join("")}</div>
    </div>
  </div>`;
}



function rank(severity) {
  const value = severity.toLowerCase();
  if (value.includes("high")) return "high";
  if (value.includes("medium") || value.includes("med")) return "medium";
  if (value.includes("low")) return "low";
  return "none";
}

function renderCodeBlock(code, language) {
  const rows = code
    .split("\n")
    .map((line) => `<div class="row"><code>${highlightLine(escapeHtml(line))}</code></div>`)
    .join("");
  const label = language ? `<header><span>${escapeHtml(language)}</span></header>` : "";
  return `<section class="code-block">${label}<pre>${rows}</pre></section>`;
}

/** Inline markdown on already-untrusted text: escape first, then add tags. */
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/&lt;br\s*\/?&gt;/gi, "<br />");
}

function highlightLine(escapedLine) {
  const keywords = new Set([
    "fun", "func", "val", "var", "let", "const", "class", "struct", "interface", "object", "enum",
    "if", "else", "return", "true", "false", "null", "new", "private", "public", "internal",
    "suspend", "async", "override", "companion", "for", "while", "when", "switch", "import",
    "package", "throws", "void", "static", "this", "super", "in", "await", "try", "catch", "throw",
  ]);
  let html = "";
  let index = 0;
  const text = escapedLine;
  while (index < text.length) {
    if (text.startsWith("//", index)) {
      html += `<span class="cmt">${text.slice(index)}</span>`;
      break;
    }
    if (text[index] === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") end += 1;
        end += 1;
      }
      html += `<span class="str">${text.slice(index, Math.min(text.length, end + 1))}</span>`;
      index = end + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index));
    if (word) {
      const token = word[0];
      const klass = keywords.has(token) ? "kw" : /^[A-Z]/.test(token) ? "typ" : "";
      html += klass ? `<span class="${klass}">${token}</span>` : token;
      index += token.length;
      continue;
    }
    const number = /^\d+/.exec(text.slice(index));
    if (number) {
      html += `<span class="num">${number[0]}</span>`;
      index += number[0].length;
      continue;
    }
    html += text[index];
    index += 1;
  }
  return html;
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function status(text) {
  statusNode.textContent = text;
}

function showError(text) {
  errorNode.hidden = false;
  errorNode.textContent = text;
}

function clearError() {
  errorNode.hidden = true;
  errorNode.textContent = "";
}

function show(node) {
  node.hidden = false;
}

function hide(node) {
  node.hidden = true;
}

function setBusy(busy) {
  for (const button of [listButton, findDifferences]) {
    button.disabled = busy;
  }
}
