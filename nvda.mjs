// Passe NVDA + Firefox (base de référence RGAA), Guidepup, sur windows-latest.
// Usage : PAGES_JSON='{...}' node nvda.mjs <sortie>   (format : commun.mjs)
// Firefox réel installé sur la machine (pas celui de Playwright), piloté par WebDriver BiDi (puppeteer-core) pour poser le focus.
import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { nvda, NVDAKeyCodeCommands as K, WindowsKeyCodes, WindowsModifiers } from "@guidepup/guidepup";
import { executer, ecrireEnvironnement, MODE, pause, sortieDe, versionPaquet } from "./commun.mjs";

const SORTIE = process.argv[2] || "sortie";
const FIREFOX = process.env.FIREFOX_BIN || "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
const ps = (cmd) => sortieDe("powershell", ["-NoProfile", "-Command", cmd]);
const versionFichier = (f) => f && ps(`(Get-Item '${f.replace(/'/g, "''")}').VersionInfo.ProductVersion`);

async function main() {
  if (!existsSync(FIREFOX)) throw new Error(`Firefox introuvable : ${FIREFOX}`);
  const nvdaExe = ps("(Get-ChildItem -Path $env:LOCALAPPDATA\\guidepup -Recurse -Filter nvda.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName");
  const env = { lecteur: "nvda", nvda: versionFichier(nvdaExe), nvda_paquet_guidepup: nvda.version, nvda_exe: nvdaExe,
    firefox: versionFichier(FIREFOX), firefox_exe: FIREFOX, windows: ps("$o = Get-CimInstance Win32_OperatingSystem; $o.Caption + ' ' + $o.Version"),
    guidepup: versionPaquet("@guidepup/guidepup"), guidepup_setup: versionPaquet("@guidepup/setup"), puppeteer_core: versionPaquet("puppeteer-core"),
    node: process.version, date: new Date().toISOString(), mode: MODE };
  ecrireEnvironnement(SORTIE, env);

  const browser = await puppeteer.launch({ browser: "firefox", executablePath: FIREFOX, headless: false, defaultViewport: null,
    args: ["-width", "1280", "-height", "900"], extraPrefsFirefox: { "intl.accept_languages": "fr-FR, fr" } });
  env.firefox_bidi = await browser.version();
  ecrireEnvironnement(SORTIE, env);
  const p = (await browser.pages())[0] || (await browser.newPage());
  const page = { goto: (u) => p.goto(u, { waitUntil: "load", timeout: 45_000 }), title: () => p.title(), evaluate: (f, a) => p.evaluate(f, a) };

  // amener NVDA sur le contenu web (repris de @guidepup/playwright navigateNVDAtoWebContent)
  async function versLeContenu() {
    const titre = (await p.title()).toLowerCase();
    for (let i = 0; i < 10; i++) {
      await nvda.perform(K.reportTitle);
      const fenetre = (await nvda.lastSpokenPhrase()).toLowerCase();
      if (fenetre.includes("firefox") || (titre && fenetre.startsWith(titre.slice(0, 20)))) break;
      await nvda.perform({ keyCode: [WindowsKeyCodes.Escape], modifiers: [WindowsModifiers.Alt] }, { capture: false });
      await pause(500);
    }
    await p.bringToFront();
    await p.evaluate(() => { document.body.focus(); document.body.click(); document.body.blur(); });
    // puppeteer démarre sur about:blank : le focus SYSTÈME reste dans l'interface de Firefox (focus JS trompeur, focusmanager.testmode).
    // F6 fait passer barre d'adresse -> page ; NVDA+Tab (focus système) doit annoncer « <titre>, document ».
    let contenu = false;
    for (let i = 0; i < 5 && !contenu; i++) {
      await nvda.perform(K.reportCurrentFocus);
      contenu = /,\s*document\b/i.test(await nvda.lastSpokenPhrase());
      if (!contenu) { await nvda.perform({ keyCode: [WindowsKeyCodes.F6], modifiers: [] }, { capture: false }); await pause(500); }
    }
    if (!contenu) console.warn(`NVDA : focus système hors du document (« ${await nvda.lastSpokenPhrase()} »)`);
    for (const c of [K.toggleBetweenBrowseAndFocusMode, K.toggleBetweenBrowseAndFocusMode, K.exitFocusMode]) {
      await nvda.perform(c, { capture: false });
      await pause(150);
    }
    return contenu;
  }

  const etape = (cmd) => () => nvda.perform(cmd, { capture: "initial" });   // balayage : la première phrase suffit, 1 s de moins par arrêt
  const lecteur = { nom: "nvda", sr: nvda, page, versLeContenu, direFocus: () => nvda.perform(K.reportCurrentFocus),
    // Tab envoyé DANS la page (BiDi) : en mode navigation, le Tab de NVDA part de son curseur virtuel, pas du focus posé (banc 10.8)
    tab: () => nvda.capture(() => p.keyboard.press("Tab")), touche: (k) => nvda.capture(() => p.keyboard.press(k)), echap: () => nvda.press("Escape"), activer: () => nvda.act(),
    arrivee: () => nvda.perform(K.reportTitle),
    debut: () => nvda.perform({ keyCode: [WindowsKeyCodes.Home], modifiers: [WindowsModifiers.Control] }),
    sequences: { titres: [etape(K.moveToNextHeading), 40], reperes: [etape(K.moveToNextLandmark), 20], liens: [etape(K.moveToNextLink), 80],
      graphiques: [etape(K.moveToNextGraphic), 40], champs: [etape(K.moveToNextFormField), 30], boutons: [etape(K.moveToNextButton), 30],
      cadres: [etape(K.moveToNextFrame), 10], tab: [etape(K.readNextFocusableItem), 60] } };

  await nvda.start({ capture: true });   // toute la parole d'une commande, pas seulement la première phrase
  try {
    await executer(lecteur, SORTIE);
  } finally {
    try { await nvda.stop(); } catch { /* déjà arrêté */ }
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
