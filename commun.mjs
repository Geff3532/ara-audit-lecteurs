// Logique commune aux passes NVDA + Firefox et VoiceOver + Safari : mêmes cibles, même format de sortie.
// Entrée (variable PAGES_JSON) : {"mode": "cible"|"complet", "pages": [{"slug", "url", "cibles": [...]}]}
// Cible : {id, test, type: "composant"|"lecture"|"cache", requete, index?, nom?, texte?, src?, pas?, focalisables?}
//   composant (7.1)          : focus sur l'élément, annonce, activation par le lecteur, annonce + états ARIA avant/après, Échap
//   lecture (1.3, 1.6, 4.13) : focus sur l'élément, annonce, puis `pas` éléments suivants (curseur du lecteur)
//   cache (10.8)             : focus juste avant la zone cachée, curseur puis Tab sur la zone : le texte caché est-il lu ?
// Mode "complet" (option) : séquences bornées (titres, repères, liens, graphiques, champs, boutons, cadres, 60 Tab).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ENTREE = JSON.parse(process.env.PAGES_JSON || "{}");
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

// --- côté Node. `l` (lecteur) : {sr, page, versLeContenu(), tab(), echap(), activer(), arrivee?(), debut(), sequences}
// page : {goto(url), title(), evaluate(fn, arg)}
async function ecoute(sr, action, attente = 1200) {
  await sr.clearSpokenPhraseLog();
  await sr.clearItemTextLog();
  await action();
  await pause(attente);
  return { parole: [...(await sr.spokenPhraseLog())], item: [...(await sr.itemTextLog())] };
}

async function cible(l, c) {
  const { sr, page } = l;
  const r = { ...c, trouve: await page.evaluate(localiser, c) };
  if (!r.trouve) return { ...r, erreur: "cible introuvable dans le navigateur (DOM différent de la collecte Chromium ?)" };
  if (c.type === "cache") {
    r.focus = await page.evaluate(poserFocus, true);
    r.depart = await ecoute(sr, async () => {}, 1000);
    const pas = c.pas || 6;
    r.fleches = await ecoute(sr, async () => { for (let i = 0; i < pas; i++) await sr.next(); }, 500);
    r.tab = await ecoute(sr, async () => { for (let i = 0; i < Math.min(pas, (c.focalisables || 0) + 2); i++) { await l.tab(); await pause(400); } }, 500);
    const t = (c.texte || "").toLowerCase().slice(0, 20);
    const entendu = (x) => !!t && [...x.parole, ...x.item].join(" ").toLowerCase().includes(t);
    r.texte_cache_entendu = { fleches: entendu(r.fleches), tab: entendu(r.tab) };
    return r;
  }
  r.focus = await page.evaluate(poserFocus, false);
  r.annonce = await ecoute(sr, async () => {}, 1500);   // focus posé en JS : le lecteur annonce l'élément focalisé
  if (c.type === "composant") {
    r.etat_avant = await page.evaluate(lireEtat);
    r.apres_activation = await ecoute(sr, () => l.activer(), 1500);
    r.etat_apres = await page.evaluate(lireEtat);
    if (r.etat_apres?.url && r.etat_avant?.url && r.etat_apres.url !== r.etat_avant.url) {
      r.navigation = r.etat_apres.url;                   // le composant a changé de page : revenir
      await page.goto(r.etat_avant.url);
      await pause(3000);
      await l.versLeContenu();
    } else {
      r.apres_echap = await ecoute(sr, () => l.echap(), 1000);
      r.etat_apres_echap = await page.evaluate(lireEtat);
    }
  } else {
    r.suite = await ecoute(sr, async () => { for (let i = 0; i < (c.pas || 3); i++) await sr.next(); }, 500);
  }
  return r;
}

async function balayage(l) {
  const out = {};
  for (const [nom, [action, max]] of Object.entries(l.sequences)) {
    await l.versLeContenu();
    await l.debut();
    const arrets = [], debut = Date.now();
    for (let i = 0; i < max && Date.now() - debut < BORNE_SEQUENCE_MS; i++) {
      await l.sr.clearSpokenPhraseLog();
      await action();
      await pause(300);
      const p = (await l.sr.spokenPhraseLog()).join(" ");
      if (arrets.length && p === arrets[arrets.length - 1]) break;   // fin de liste : le lecteur répète la même annonce
      arrets.push(p);
    }
    out[nom] = { arrets, nb: arrets.length, duree_s: Math.round((Date.now() - debut) / 1000) };
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
    await l.versLeContenu();
    if (l.arrivee) res.arrivee = await ecoute(l.sr, l.arrivee, 500);
    if (MODE === "complet") res.sequences = await balayage(l);
    else {
      res.cibles = [];
      for (const c of p.cibles || []) {
        if (Date.now() - t0 > BORNE_PAGE_MS) { res.cibles.push({ ...c, erreur: "borne de temps de la page atteinte" }); continue; }
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

// Parcourt les pages de l'entrée et écrit <sortie>/<slug>.json ; environnement.json est écrit par l'appelant.
export async function executer(l, sortie) {
  mkdirSync(sortie, { recursive: true });
  for (const p of ENTREE.pages || []) {
    console.log(`page ${p.slug} ${p.url} (${(p.cibles || []).length} cibles)`);
    const res = await Promise.race([traiterPage(l, p),
      pause(BORNE_PAGE_MS + 120_000).then(() => ({ slug: p.slug, url: p.url, lecteur: l.nom, erreur: "page abandonnée : délai dépassé" }))]);
    writeFileSync(join(sortie, `${p.slug}.json`), JSON.stringify(res, null, 1));
  }
}

export const ecrireEnvironnement = (sortie, env) => {
  mkdirSync(sortie, { recursive: true });
  writeFileSync(join(sortie, "environnement.json"), JSON.stringify(env, null, 1));
  console.log(JSON.stringify(env));
};
