// Passe de restitution NVDA + Firefox (base de référence RGAA) pilotée par Guidepup.
// Usage : PAGES_JSON='{"mode":"cible","pages":[{"slug","url","cibles":[...]}]}' node nvda.mjs <dossier-sortie>
// Écrit <sortie>/<slug>.json par page et <sortie>/environnement.json (versions exactes).
// Cible : {id, test, type: "composant"|"lecture"|"cache", requete, index?, nom?, texte?, src?, pas?}
//   composant (7.1)        : focus sur l'élément, annonce, Entrée (NVDA), annonce + états ARIA avant/après, Échap
//   lecture (1.3, 1.6, 4.13) : focus sur l'élément, annonce, puis `pas` éléments suivants (flèche bas)
//   cache (10.8)           : focus juste avant la zone cachée, flèches puis Tab sur la zone : le texte caché est-il lu ?
// Mode "complet" (option) : balayage H, D, K, G, F, B, M et 60 Tab, chaque séquence bornée.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { nvda, NVDAKeyCodeCommands as K, WindowsKeyCodes, WindowsModifiers } from "@guidepup/guidepup";

const SORTIE = process.argv[2] || "sortie";
const FIREFOX = process.env.FIREFOX_BIN || "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
const ENTREE = JSON.parse(process.env.PAGES_JSON || "{}");
const MODE = ENTREE.mode || "cible";
const BORNE_PAGE_MS = 8 * 60_000;     // une page ne peut pas bloquer le run
const BORNE_SEQUENCE_MS = 90_000;     // mode complet : une séquence (H, K, Tab...) au plus 90 s
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).trim();
const versionFichier = (f) => ps(`(Get-Item '${f.replace(/'/g, "''")}').VersionInfo.ProductVersion`);
const lirePkg = (p) => JSON.parse(readFileSync(new URL(`./node_modules/${p}/package.json`, import.meta.url))).version;

function environnement() {
  const nvdaExe = ps("(Get-ChildItem -Path $env:LOCALAPPDATA\\guidepup, $env:USERPROFILE\\AppData\\Local\\guidepup -Recurse -Filter nvda.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName");
  return {
    nvda: nvdaExe ? versionFichier(nvdaExe) : null, nvda_paquet_guidepup: nvda.version, nvda_exe: nvdaExe,
    firefox: versionFichier(FIREFOX), firefox_exe: FIREFOX,
    windows: ps("$o = Get-CimInstance Win32_OperatingSystem; $o.Caption + ' ' + $o.Version"),
    guidepup: lirePkg("@guidepup/guidepup"), guidepup_setup: lirePkg("@guidepup/setup"), puppeteer_core: lirePkg("puppeteer-core"),
    node: process.version, date: new Date().toISOString(), mode: MODE,
  };
}

// --- journal des annonces : chaque mesure part d'un journal vidé
async function ecoute(action, attente = 1200) {
  await nvda.clearSpokenPhraseLog();
  await nvda.clearItemTextLog();
  await action();
  await pause(attente);
  return { parole: [...(await nvda.spokenPhraseLog())], item: [...(await nvda.itemTextLog())] };
}

// --- amener NVDA sur le contenu web de Firefox (repris de @guidepup/playwright navigateNVDAtoWebContent)
async function versLeContenu(page) {
  const titre = (await page.title()).toLowerCase();
  for (let i = 0; i < 10; i++) {
    await nvda.perform(K.reportTitle);
    const fenetre = (await nvda.lastSpokenPhrase()).toLowerCase();
    if (fenetre.includes("firefox") || (titre && fenetre.startsWith(titre.slice(0, 20)))) break;
    await nvda.perform({ keyCode: [WindowsKeyCodes.Escape], modifiers: [WindowsModifiers.Alt] }, { capture: false });
    await pause(500);
  }
  await page.bringToFront();
  await page.evaluate(() => { document.body.focus(); document.body.click(); document.body.blur(); });
  for (const c of [K.readNextFocusableItem, K.toggleBetweenBrowseAndFocusMode, K.toggleBetweenBrowseAndFocusMode, K.exitFocusMode]) {
    await nvda.perform(c, { capture: false });
    await pause(150);
  }
}

// --- dans la page : retrouver une cible (requête + index, vérifiés par le nom ou le texte)
function localiser(c) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const nom = (e) => norm(e.getAttribute("aria-label") ||
    (e.getAttribute("aria-labelledby") || "").split(/\s+/).map((i) => document.getElementById(i)?.textContent || "").join(" ") ||
    e.getAttribute("alt") || e.textContent || e.getAttribute("title"));
  const ok = (e) => e && (c.nom == null || nom(e) === c.nom) && (!c.texte || norm(e.textContent).startsWith(c.texte)) &&
    (!c.src || (e.getAttribute("src") || "").startsWith(c.src));
  const els = [...document.querySelectorAll(c.requete)];
  const e = c.index != null && ok(els[c.index]) ? els[c.index] : els.find(ok);
  document.querySelectorAll("[data-nvda-cible]").forEach((x) => x.removeAttribute("data-nvda-cible"));
  if (!e) return null;
  e.setAttribute("data-nvda-cible", "1");
  const r = e.getBoundingClientRect();
  return { nom: nom(e).slice(0, 160), tag: e.tagName.toLowerCase(), visible: r.width > 0 && r.height > 0 };
}

const etat = (page) => page.evaluate(() => {
  const e = document.querySelector("[data-nvda-cible]");
  const dlg = [...document.querySelectorAll("[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]")].filter((d) => d.getBoundingClientRect().width > 0);
  return e && { "aria-expanded": e.getAttribute("aria-expanded"), "aria-pressed": e.getAttribute("aria-pressed"),
    "aria-selected": e.getAttribute("aria-selected"), "aria-checked": e.getAttribute("aria-checked"), url: location.href, dialogues: dlg.length,
    focus: (document.activeElement?.tagName || "").toLowerCase() + " " + (document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) };
});

// focus sur la cible (ou, pour une zone cachée, sur ce qui la précède) ; tabindex=-1 ajouté seulement si l'élément n'est pas focalisable
const focaliser = (page, avant = false) => page.evaluate((avant) => {
  let e = document.querySelector("[data-nvda-cible]");
  if (avant) e = e.previousElementSibling || e.parentElement;
  e.scrollIntoView({ block: "center" });
  let ajoute = false;
  if (e.tabIndex < 0 && !e.hasAttribute("tabindex")) { e.setAttribute("tabindex", "-1"); ajoute = true; }
  e.focus();
  return { focus_obtenu: document.activeElement === e || e.contains(document.activeElement), tabindex_ajoute: ajoute };
}, avant);

async function cible(page, c) {
  const r = { ...c, trouve: await page.evaluate(localiser, c) };
  if (!r.trouve) return { ...r, erreur: "cible introuvable dans Firefox (DOM différent de la collecte Chromium ?)" };
  if (c.type === "cache") {
    r.focus = await focaliser(page, true);
    r.depart = await ecoute(async () => {}, 1000);
    const pas = c.pas || 6;
    r.fleches = await ecoute(async () => { for (let i = 0; i < pas; i++) await nvda.next(); }, 500);
    r.tab = await ecoute(async () => { for (let i = 0; i < Math.min(pas, (c.focalisables || 0) + 2); i++) await nvda.perform(K.readNextFocusableItem); }, 500);
    const t = (c.texte || "").toLowerCase().slice(0, 20);
    const entendu = (x) => t && [...x.parole, ...x.item].join(" ").toLowerCase().includes(t);
    r.texte_cache_entendu = { fleches: entendu(r.fleches), tab: entendu(r.tab) };
    return r;
  }
  r.focus = await focaliser(page);
  r.annonce = await ecoute(async () => {}, 1500);   // focus posé en JS : NVDA annonce l'élément focalisé
  if (c.type === "composant") {
    r.etat_avant = await etat(page);
    r.apres_entree = await ecoute(() => nvda.act(), 1500);
    r.etat_apres = await etat(page);
    if (r.etat_apres && r.etat_avant && r.etat_apres.url !== r.etat_avant.url) {
      r.navigation = r.etat_apres.url;                   // le composant a changé de page : revenir
      await page.goto(r.etat_avant.url, { waitUntil: "load", timeout: 45_000 });
      await pause(3000);
      await versLeContenu(page);
    } else {
      r.apres_echap = await ecoute(() => nvda.press("Escape"), 1000);
      r.etat_apres_echap = await etat(page);
    }
  } else {
    r.suite = await ecoute(async () => { for (let i = 0; i < (c.pas || 3); i++) await nvda.next(); }, 500);
  }
  return r;
}

// --- mode complet (option) : séquences bornées en nombre d'arrêts et en durée
const SEQUENCES = { titres: [K.moveToNextHeading, 40], reperes: [K.moveToNextLandmark, 20], liens: [K.moveToNextLink, 80],
  graphiques: [K.moveToNextGraphic, 40], champs: [K.moveToNextFormField, 30], boutons: [K.moveToNextButton, 30],
  cadres: [K.moveToNextFrame, 10], tab: [K.readNextFocusableItem, 60] };

async function balayage(page) {
  const out = {};
  for (const [nom, [cmd, max]] of Object.entries(SEQUENCES)) {
    await versLeContenu(page);
    await nvda.perform({ keyCode: [WindowsKeyCodes.Home], modifiers: [WindowsModifiers.Control] });
    const arrets = [], debut = Date.now();
    await nvda.clearSpokenPhraseLog();
    for (let i = 0; i < max && Date.now() - debut < BORNE_SEQUENCE_MS; i++) {
      await nvda.perform(cmd);
      const p = await nvda.lastSpokenPhrase();
      if (arrets.length && p === arrets[arrets.length - 1]) break;     // fin de liste : NVDA répète « pas de ... suivant »
      arrets.push(p);
    }
    out[nom] = { arrets, nb: arrets.length, duree_s: Math.round((Date.now() - debut) / 1000) };
  }
  return out;
}

async function traiterPage(page, p) {
  const res = { slug: p.slug, url: p.url, mode: MODE, debut: new Date().toISOString() };
  const t0 = Date.now();
  try {
    await page.goto(p.url, { waitUntil: "load", timeout: 45_000 });
    await pause(4000);
    res.titre = await page.title();
    await versLeContenu(page);
    res.arrivee = await ecoute(() => nvda.perform(K.reportTitle), 500);
    if (MODE === "complet") res.sequences = await balayage(page);
    else {
      res.cibles = [];
      for (const c of p.cibles || []) {
        if (Date.now() - t0 > BORNE_PAGE_MS) { res.cibles.push({ ...c, erreur: "borne de temps de la page atteinte" }); continue; }
        try { res.cibles.push(await cible(page, c)); } catch (e) { res.cibles.push({ ...c, erreur: String(e).slice(0, 300) }); }
        console.log(`  ${p.slug} ${c.id} ${c.test} ${JSON.stringify(res.cibles.at(-1).annonce?.parole || res.cibles.at(-1).fleches?.parole || res.cibles.at(-1).erreur || "").slice(0, 160)}`);
      }
    }
  } catch (e) {
    res.erreur = String(e).slice(0, 500);
  }
  res.duree_s = Math.round((Date.now() - t0) / 1000);
  return res;
}

async function main() {
  mkdirSync(SORTIE, { recursive: true });
  if (!existsSync(FIREFOX)) throw new Error(`Firefox introuvable : ${FIREFOX}`);
  const env = environnement();
  writeFileSync(join(SORTIE, "environnement.json"), JSON.stringify(env, null, 1));
  console.log(JSON.stringify(env));
  const browser = await puppeteer.launch({ browser: "firefox", executablePath: FIREFOX, headless: false, defaultViewport: null,
    args: ["-width", "1280", "-height", "900"], extraPrefsFirefox: { "intl.accept_languages": "fr-FR, fr" } });
  env.firefox_bidi = await browser.version();
  writeFileSync(join(SORTIE, "environnement.json"), JSON.stringify(env, null, 1));
  const page = (await browser.pages())[0] || (await browser.newPage());
  await nvda.start();
  try {
    for (const p of ENTREE.pages || []) {
      console.log(`page ${p.slug} ${p.url} (${(p.cibles || []).length} cibles)`);
      const res = await Promise.race([traiterPage(page, p),
        pause(BORNE_PAGE_MS + 120_000).then(() => ({ slug: p.slug, url: p.url, erreur: "page abandonnée : délai dépassé" }))]);
      writeFileSync(join(SORTIE, `${p.slug}.json`), JSON.stringify(res, null, 1));
    }
  } finally {
    try { await nvda.stop(); } catch { /* NVDA déjà arrêté */ }
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
