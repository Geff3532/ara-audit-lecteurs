// Passe VoiceOver + Safari (base de référence RGAA), Guidepup, sur macOS (GitHub Actions).
// Usage : PAGES_JSON='{...}' node voiceover.mjs <sortie>   (format : commun.mjs)
// Safari réel (/Applications/Safari.app, pas WebKit de Playwright), piloté par safaridriver (WebDriver) pour naviguer et poser
// le focus ; VoiceOver suit le focus clavier. Option+Tab et Échap passent par WebDriver (une frappe système interromprait la session).
import { spawn } from "node:child_process";
import { voiceOver, voiceOverKeyCodeCommands as K, macOSActivate, MacOSApplications } from "@guidepup/guidepup";
// import profond (pas de champ "exports" dans le package.json de Guidepup) : dernière phrase RÉELLE de VO, pour écarter les échos
import { lastSpokenPhrase as derniereVO } from "@guidepup/guidepup/lib/macOS/VoiceOver/lastSpokenPhrase.js";
import { cleanSpokenPhrase } from "@guidepup/guidepup/lib/macOS/VoiceOver/cleanSpokenPhrase.js";
import { executer, ecrireEnvironnement, MODE, pause, sortieDe, versionPaquet } from "./commun.mjs";

const SORTIE = process.argv[2] || "sortie";
const PORT = 4444;
const plist = (app, cle) => sortieDe("defaults", ["read", `${app}/Contents/Info`, cle]);

async function wd(methode, chemin, corps) {
  const r = await fetch(`http://127.0.0.1:${PORT}${chemin}`, { method: methode, headers: { "content-type": "application/json" },
    body: corps && JSON.stringify(corps) });
  const j = await r.json();
  if (!r.ok) throw new Error(`WebDriver ${chemin} : ${JSON.stringify(j.value).slice(0, 300)}`);
  return j.value;
}

async function main() {
  const env = { lecteur: "voiceover", voiceover: plist("/System/Library/CoreServices/VoiceOver.app", "CFBundleShortVersionString"),
    voiceover_build: plist("/System/Library/CoreServices/VoiceOver.app", "CFBundleVersion"),
    safari: plist("/Applications/Safari.app", "CFBundleShortVersionString"),
    macos: `${sortieDe("sw_vers", ["-productVersion"])} (${sortieDe("sw_vers", ["-buildVersion"])})`,
    guidepup: versionPaquet("@guidepup/guidepup"), guidepup_setup: versionPaquet("@guidepup/setup"),
    node: process.version, date: new Date().toISOString(), mode: MODE };
  ecrireEnvironnement(SORTIE, env);

  const pilote = spawn("safaridriver", ["-p", String(PORT)], { stdio: "inherit" });
  let session = null;
  for (let i = 0; i < 20 && !session; i++) {
    await pause(1000);
    session = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } }).catch((e) => (i === 19 ? Promise.reject(e) : null));
  }
  env.safari_webdriver = session.capabilities.browserVersion;
  ecrireEnvironnement(SORTIE, env);
  const s = `/session/${session.sessionId}`;
  await wd("POST", `${s}/window/rect`, { width: 1280, height: 900 }).catch(() => {});
  const CLES = { ArrowLeft: "\uE012", ArrowUp: "\uE013", ArrowRight: "\uE014", ArrowDown: "\uE015" };   // codes WebDriver
  const touche = (k) => wd("POST", `${s}/actions`, { actions: [{ type: "key", id: "clavier", actions: [{ type: "keyDown", value: k }, { type: "keyUp", value: k }] }] });
  // Option+Tab : WebKit inverse tabsToLinks quand Option est enfoncée -> Tab atteint aussi les liens (réglage Safari sans effet en automatisation)
  const optionTab = () => wd("POST", `${s}/actions`, { actions: [{ type: "key", id: "clavier", actions: [
    { type: "keyDown", value: "\uE00A" }, { type: "keyDown", value: "\uE004" }, { type: "keyUp", value: "\uE004" }, { type: "keyUp", value: "\uE00A" }] }] });
  const page = { goto: (url) => wd("POST", `${s}/url`, { url }), title: () => wd("GET", `${s}/title`),
    evaluate: (f, a) => wd("POST", `${s}/execute/sync`, { script: `return (${f}).apply(null, arguments)`, args: a === undefined ? [] : [a] }) };

  async function versLeContenu() {
    await macOSActivate(MacOSApplications.Safari);
    await pause(1000);
    await page.evaluate(() => { document.body.focus(); window.scrollTo(0, 0); });
  }

  const etape = (cmd) => () => voiceOver.perform(cmd);
  const lecteur = { nom: "voiceover", sr: voiceOver, page, versLeContenu,
    // touches WebDriver = actions extérieures à Guidepup : capturées par voiceOver.capture()
    tab: () => voiceOver.capture(optionTab), touche: (k) => voiceOver.capture(() => touche(CLES[k] || k)), echap: () => voiceOver.capture(() => touche("\uE00C")), activer: () => voiceOver.act(),
    direFocus: () => voiceOver.perform(K.describeItemWithKeyboardFocus),
    derniere: async () => cleanSpokenPhrase(await derniereVO().catch(() => "")),
    captureFleches: "initial",   // capture:true coûte jusqu'à 100 sondages osascript par flèche ; les échos sont filtrés par ecoute()
    debut: () => page.evaluate(() => { const e = document.querySelector("a[href],button,[tabindex]"); e?.focus(); e?.blur(); window.scrollTo(0, 0); }),
    sequences: { titres: [etape(K.findNextHeading), 40], reperes: [() => voiceOver.nextLandmark(), 20], liens: [etape(K.findNextLink), 80],
      graphiques: [etape(K.findNextGraphic), 40], controles: [etape(K.findNextControl), 40], cadres: [etape(K.moveToNextFrame), 10],
      tab: [() => voiceOver.capture(optionTab), 60] } };

  await voiceOver.start({ capture: true });   // toute la parole d'une commande, pas seulement la première phrase
  try {
    await executer(lecteur, SORTIE);
  } finally {
    try { await voiceOver.stop(); } catch { /* déjà arrêté */ }
    await wd("DELETE", s).catch(() => {});
    pilote.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
