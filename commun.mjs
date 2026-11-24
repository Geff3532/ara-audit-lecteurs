// Logique commune aux passes NVDA + Firefox et VoiceOver + Safari : mêmes cibles, même format de sortie.
// Entrée (variable PAGES_JSON) : {"mode": "cible"|"complet", "pages": [{"slug", "url", "cibles": [...]}]}
// Cible : {id, test, type: "composant"|"lecture"|"cache", requete, index?, nom?, texte?, src?, pas?, focalisables?}
//   composant (7.1)          : focus sur l'élément, annonce, activation par le lecteur, annonce + états ARIA avant/après, Échap
//   lecture (1.3, 1.6, 4.13) : focus sur l'élément, annonce, puis `pas` éléments suivants (curseur du lecteur)
//   cache (10.8)             : focus juste avant la zone cachée, curseur puis Tab sur la zone : le texte caché est-il lu ?
// Mode "complet" (option) : séquences bornées (titres, repères, liens, graphiques, champs, boutons, cadres, 60 Tab).
// Capture : Guidepup n'enregistre la parole que pendant SES commandes ; une action extérieure (focus posé en JS, touche WebDriver)
// doit passer par sr.capture(), sinon le journal reste vide (essai du 24/11/2026 : toutes les annonces au focus vides).
// Banc d'essai : PAGES_JSON='{"banc": true}' sert banc/banc.html en local, prend banc/pages.json et vérifie la santé du harnais.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BANC = JSON.parse(process.env.PAGES_JSON || "{}").banc === true;
export const ENTREE = BANC ? JSON.parse(readFileSync(new URL("./banc/pages.json", import.meta.url))) : JSON.parse(process.env.PAGES_JSON || "{}");
export const MODE = ENTREE.mode || "cible";
const BORNE_PAGE_MS = 8 * 60_000;     // une page ne peut pas bloquer le run
const BORNE_SEQUENCE_MS = 90_000;     // mode complet : une séquence au plus 90 s
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const sortieDe = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8" }).trim(); } catch { return null; } };
export const versionPaquet = (p) => JSON.parse(readFileSync(new URL(`./node_modules/${p}/package.json`, import.meta.url))).version;

// --- exécutées DANS la page (sérialisées) : aucune référence extérieure
function localiser(c) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const nom = (e) => norm(e.getAttribute("aria-label") ||
    (e.getAttribute("aria-labelledby") || "").split(/\s+/).map((i) => document.getElementById(i)?.textContent || "").join(" ") ||
    e.getAttribute("alt") || e.textContent || e.getAttribute("title"));
  // texte ou src : critère sûr ; nom : préféré à l'index (le DOM du navigateur peut différer de celui de la collecte Chromium)
  const els = [...document.querySelectorAll(c.requete)];
  let e = null, par = null;
  if (c.texte) { e = els.find((x) => norm(x.textContent).startsWith(c.texte)); par = "texte"; }
  else if (c.src) { e = els.find((x) => (x.getAttribute("src") || "").startsWith(c.src)); par = "src"; }
  else if (c.nom != null) {
    const memes = els.filter((x) => nom(x) === c.nom);
    e = memes.includes(els[c.index]) ? els[c.index] : memes[0]; par = "nom";
  }
  if (!e && c.index != null && !c.texte && !c.src) { e = els[c.index]; par = "index"; }
  document.querySelectorAll("[data-lecteur-cible]").forEach((x) => x.removeAttribute("data-lecteur-cible"));
  if (!e) return null;
  e.setAttribute("data-lecteur-cible", "1");
  const r = e.getBoundingClientRect();
  return { par, nom: nom(e).slice(0, 160), tag: e.tagName.toLowerCase(), visible: r.width > 0 && r.height > 0 };
}

function lireEtat() {
  const e = document.querySelector("[data-lecteur-cible]");
  const dlg = [...document.querySelectorAll("[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]")].filter((d) => d.getBoundingClientRect().width > 0);
  const a = document.activeElement;
  return e && { "aria-expanded": e.getAttribute("aria-expanded"), "aria-pressed": e.getAttribute("aria-pressed"),
    "aria-selected": e.getAttribute("aria-selected"), "aria-checked": e.getAttribute("aria-checked"), url: location.href, dialogues: dlg.length,
    focus: ((a?.tagName || "").toLowerCase() + " " + (a?.getAttribute("aria-label") || a?.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 80) };
}

// focus sur la cible (ou, pour une zone cachée, sur ce qui la précède) ; tabindex=-1 ajouté seulement si l'élément n'est pas focalisable
function poserFocus(avant) {
  let e = document.querySelector("[data-lecteur-cible]");
  if (avant) e = e.previousElementSibling || e.parentElement;
  e.scrollIntoView({ block: "center" });
  let ajoute = false;
  if (e.tabIndex < 0 && !e.hasAttribute("tabindex")) { e.setAttribute("tabindex", "-1"); ajoute = true; }
  e.focus();
  return { focus_obtenu: document.activeElement === e || e.contains(document.activeElement), tabindex_ajoute: ajoute };
}

// --- côté Node. `l` (lecteur) : {nom, sr, page, versLeContenu() -> false si le focus n'atteint pas le document, tab(), echap(),
//   activer(), direFocus(), derniere?() (VO : dernière phrase réelle), captureFleches?, arrivee?(), debut(), sequences}
// page : {goto(url), title(), evaluate(fn, arg)}
// `parole` = ce qui a été DIT ; `item` = information seulement (VO : texte sous le curseur VO, jamais vide ; NVDA : copie de parole).
async function ecoute(l, action, attente = 1200) {
  const { sr } = l;
  const avant = l.derniere ? await l.derniere() : null;
  await sr.clearSpokenPhraseLog();
  await sr.clearItemTextLog();
  await action();
  await pause(attente);
  const brut = [...(await sr.spokenPhraseLog())];
  const item = [...(await sr.itemTextLog())];
  if (avant == null) return { parole: brut, item };
  // VO : une action muette renvoie la phrase précédente (VoiceOverClient.js:180-218) ; une vraie répétition est aussi écartée, mais comptée
  const echo = (x, k) => !!x && !!(k ? brut[k - 1] : avant) && (k ? brut[k - 1] : avant).endsWith(x);
  const parole = brut.map((x, k) => (echo(x, k) ? "" : x));
  const repete = brut.filter((x, k) => echo(x, k));
  return repete.length ? { parole, item, repete } : { parole, item };
}

const dit = (x) => !!x && x.parole.some((s) => s && s.trim());

async function cible(l, c) {
  const { sr, page } = l;
  const r = { ...c, trouve: await page.evaluate(localiser, c) };
  if (!r.trouve) return { ...r, erreur: "cible introuvable dans le navigateur (DOM différent de la collecte Chromium ?)" };
  const focusCapture = (avant) => ecoute(l, async () => { r.focus = (await sr.capture(() => page.evaluate(poserFocus, avant))).result; }, 500);
  const fleches = (n) => ecoute(l, async () => { for (let i = 0; i < n; i++) await sr.next(l.captureFleches ? { capture: l.captureFleches } : undefined); }, 500);
  if (c.type === "cache") {
    r.depart = await focusCapture(true);
    const pas = c.pas || 6;
    r.fleches = await fleches(pas);
    r.focus_dans_zone = false;   // fait DOM : Tab a posé le focus dans la zone aria-hidden
    r.tab = await ecoute(l, async () => {
      for (let i = 0; i < Math.min(pas, (c.focalisables || 0) + 2); i++) {
        await l.tab(); await pause(400);
        r.focus_dans_zone ||= await page.evaluate(() => !!document.activeElement?.closest("[data-lecteur-cible]"));
      }
    }, 500);
    const t = (c.texte || "").toLowerCase().slice(0, 20);
    const entendu = (x) => !!t && x.parole.join(" ").toLowerCase().includes(t);
    r.texte_cache_entendu = { fleches: entendu(r.fleches), tab: entendu(r.tab) };
    return r;
  }
  r.annonce = await focusCapture(false);   // ce que le lecteur dit spontanément quand le focus arrive
  if (!dit(r.annonce)) r.annonce_demandee = await ecoute(l, l.direFocus, 500);   // sinon : on lui demande l'élément focalisé
  if (c.type === "composant") {
    r.etat_avant = await page.evaluate(lireEtat);
    r.apres_activation = await ecoute(l, () => l.activer(), 1500);
    r.etat_apres = await page.evaluate(lireEtat);
    if (r.etat_apres?.url && r.etat_avant?.url && r.etat_apres.url !== r.etat_avant.url) {
      r.navigation = r.etat_apres.url;                   // le composant a changé de page : revenir
      await page.goto(r.etat_avant.url);
      await pause(3000);
      await l.versLeContenu();
    } else {
      r.apres_echap = await ecoute(l, () => l.echap(), 1000);
      r.etat_apres_echap = await page.evaluate(lireEtat);
    }
  } else {
    r.suite = await fleches(c.pas || 3);
  }
  return r;
}

async function balayage(l, t0) {
  const out = {};
  for (const [nom, [action, max]] of Object.entries(l.sequences)) {
    if (Date.now() - t0 > BORNE_PAGE_MS) { out[nom] = { fin: "borne_page" }; continue; }
    await l.versLeContenu();
    await l.debut();
    const arrets = [], debut = Date.now();
    let fin = "max";
    for (let i = 0; i < max && Date.now() - debut < BORNE_SEQUENCE_MS; i++) {
      await l.sr.clearSpokenPhraseLog();
      await action();
      await pause(300);
      const p = (await l.sr.spokenPhraseLog()).join(" ");
      if (arrets.length && p === arrets[arrets.length - 1]) { fin = "repetition"; break; }   // fin de liste : le lecteur répète
      arrets.push(p);
    }
    if (fin === "max" && Date.now() - debut >= BORNE_SEQUENCE_MS) fin = "borne";
    out[nom] = { arrets, nb: arrets.length, fin, duree_s: Math.round((Date.now() - debut) / 1000) };
  }
  return out;
}

async function traiterPage(l, p) {
  const res = { slug: p.slug, url: p.url, lecteur: l.nom, mode: MODE, debut: new Date().toISOString() };
  const t0 = Date.now();
  try {
    await l.page.goto(p.url);
    await pause(4000);
    res.titre = await l.page.title();
    const contenu = await l.versLeContenu();
    if (contenu === false) res.focus_contenu = false;   // NVDA : focus système resté dans l'interface de Firefox
    if (l.arrivee) res.arrivee = await ecoute(l, l.arrivee, 500);
    if (MODE === "complet") res.sequences = await balayage(l, t0);
    else {
      res.cibles = [];
      for (const c of p.cibles || []) {
        // marge de 2 min avant la borne : une cible lancée juste avant a le temps de finir, la page n'est pas perdue par la course
        if (Date.now() - t0 > BORNE_PAGE_MS - 120_000) { res.cibles.push({ ...c, erreur: "borne de temps de la page atteinte" }); continue; }
        try { res.cibles.push(await cible(l, c)); } catch (e) { res.cibles.push({ ...c, erreur: String(e).slice(0, 300) }); }
        const x = res.cibles.at(-1);
        console.log(`  ${p.slug} ${c.id} ${JSON.stringify(x.annonce?.parole || x.fleches?.parole || x.erreur || "").slice(0, 160)}`);
      }
    }
  } catch (e) {
    res.erreur = String(e).slice(0, 500);
  }
  res.duree_s = Math.round((Date.now() - t0) / 1000);
  return res;
}

const BUDGET_JOB_MS = 20 * 60_000;   // sous les timeout-minutes du workflow (VO 30 min, dont ~5 de préparation)

// Parcourt les pages de l'entrée et écrit <sortie>/<slug>.json ; environnement.json est écrit par l'appelant.
export async function executer(l, sortie) {
  mkdirSync(sortie, { recursive: true });
  const serveur = BANC && createServer((_, rep) => rep.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(readFileSync(new URL("./banc/banc.html", import.meta.url)))).listen(8765, "127.0.0.1")
    .on("error", (e) => { console.error(`serveur du banc : ${e}`); process.exitCode = 1; });
  const tJob = Date.now();
  try {
    for (const p of ENTREE.pages || []) {
      if (Date.now() - tJob > BUDGET_JOB_MS) {
        writeFileSync(join(sortie, `${p.slug}.json`), JSON.stringify({ slug: p.slug, url: p.url, lecteur: l.nom, erreur: "non traitée : budget du job" }));
        continue;
      }
      console.log(`page ${p.slug} ${p.url} (${(p.cibles || []).length} cibles)`);
      let minuteur;   // annulé ensuite : sinon il retient le processus 10 min après la dernière page (minutes facturées)
      const borne = new Promise((r) => { minuteur = setTimeout(() => r({ slug: p.slug, url: p.url, lecteur: l.nom, erreur: "page abandonnée : délai dépassé" }), BORNE_PAGE_MS + 120_000); });
      const res = await Promise.race([traiterPage(l, p), borne]);
      clearTimeout(minuteur);
      writeFileSync(join(sortie, `${p.slug}.json`), JSON.stringify(res, null, 1));
      if (BANC) {
        const ko = (await import("./banc/verifier.mjs")).verifier(res);
        console.log(ko.length ? `BANC ${l.nom} : ${ko.length} échec(s)\n  ${ko.join("\n  ")}` : `BANC ${l.nom} : OK`);
        if (ko.length) process.exitCode = 1;
      }
    }
  } finally {
    if (serveur) serveur.close();
  }
}

export const ecrireEnvironnement = (sortie, env) => {
  mkdirSync(sortie, { recursive: true });
  writeFileSync(join(sortie, "environnement.json"), JSON.stringify(env, null, 1));
  console.log(JSON.stringify(env));
};
