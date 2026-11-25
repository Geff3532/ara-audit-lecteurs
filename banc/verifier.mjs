// Contrôle de SANTÉ du harnais sur banc.html (pas un jugement RGAA) : chaque phase doit avoir capturé de la parole,
// l'activation doit changer l'état des vrais composants et pas celui du composant inerte. Renvoie la liste des échecs.
// seule `parole` prouve ce qui a été dit (VO : `item` = texte sous le curseur, jamais vide ; les échos sont déjà retirés par ecoute())
const dit = (x) => !!x && (x.parole || []).some((s) => s && s.trim());
const texte = (x) => (x?.parole || []).join(" ").toLowerCase();

export function verifier(res) {
  const ko = [], c = Object.fromEntries((res.cibles || []).map((x) => [x.id, x]));
  const exiger = (ok, msg) => { if (!ok) ko.push(msg); };
  exiger(!res.erreur, `page : ${res.erreur}`);
  exiger(res.focus_contenu !== false, "page : focus système hors du document (interface du navigateur)");
  for (const id of ["7.1-volet", "7.1-inerte", "7.1-boite", "4.13-cadre", "10.8-zone"]) {
    exiger(c[id] && !c[id].erreur, `${id} : ${c[id]?.erreur || "absente"}`);
  }
  const annonce = (x) => dit(x?.annonce) || dit(x?.annonce_demandee);
  const v = c["7.1-volet"], i = c["7.1-inerte"], b = c["7.1-boite"], f = c["4.13-cadre"], z = c["10.8-zone"];
  exiger(annonce(v) && /panneau/.test(texte(v.annonce) + texte(v.annonce_demandee)), "7.1-volet : focus non annoncé");
  exiger(v?.etat_avant?.["aria-expanded"] === "false" && v?.etat_apres?.["aria-expanded"] === "true", "7.1-volet : l'activation n'a pas ouvert le volet");
  exiger(dit(v?.apres_activation), "7.1-volet : rien capturé après activation");
  exiger(annonce(i) && /inerte/.test(texte(i.annonce) + texte(i.annonce_demandee)), "7.1-inerte : focus non annoncé");
  exiger(i?.etat_apres?.["aria-expanded"] === "false", "7.1-inerte : état modifié alors que le composant est inerte");
  exiger(annonce(b), "7.1-boite : focus non annoncé");
  exiger(b?.etat_apres?.dialogues >= 1, "7.1-boite : la boîte ne s'est pas ouverte");
  exiger(dit(b?.apres_activation), "7.1-boite : rien capturé après activation");
  exiger(b?.etat_apres_echap?.dialogues === 0, "7.1-boite : Échap n'a pas fermé la boîte");
  exiger(annonce(f), "4.13-cadre : focus non annoncé");
  const dedans = (f?.interieur || []).filter((a) => a.dans_cadre);
  exiger(dedans.length >= 2, "4.13-cadre : Tab n'a pas parcouru les commandes du cadre (fait DOM)");
  exiger(/lecture/.test(dedans.map(texte).join(" ")), "4.13-cadre : commande « Lecture » du cadre non restituée");
  exiger(f?.interieur?.at(-1)?.dans_cadre === false, "4.13-cadre : sortie du cadre non atteinte (Tab bloqué dedans ?)");
  exiger(dit(z?.fleches), "10.8-zone : rien capturé aux flèches");
  exiger(dit(z?.tab), "10.8-zone : rien capturé au Tab");
  exiger(z?.focus_dans_zone === true, "10.8-zone : Tab n'a pas atteint le lien de la zone cachée (fait DOM)");
  exiger(/lien après/.test(texte(z?.tab)), "10.8-zone : Tab n'atteint pas les liens (tabsToLinks Safari ?)");
  return ko;
}

// auto-test : node banc/verifier.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import("node:assert")).default;
  const p = (s) => ({ parole: [s], item: [] }), vide = { parole: [], item: [""] };
  const bon = { cibles: [
    { id: "7.1-volet", annonce: p("Ouvrir le panneau, bouton, réduit"), apres_activation: p("développé"),
      etat_avant: { "aria-expanded": "false" }, etat_apres: { "aria-expanded": "true" } },
    { id: "7.1-inerte", annonce: vide, annonce_demandee: p("Menu inerte bouton"), apres_activation: vide, etat_apres: { "aria-expanded": "false" } },
    { id: "7.1-boite", annonce: p("Ouvrir la boîte"), apres_activation: p("Boîte de test dialogue"), etat_apres: { dialogues: 1 }, etat_apres_echap: { dialogues: 0 } },
    { id: "4.13-cadre", annonce: p("Lecteur vidéo témoin, cadre"), interieur: [{ ...p("Lecture, bouton bascule, non enfoncé"), dans_cadre: true },
      { ...p("Sous-titres, bouton"), dans_cadre: true }, { ...p("Lien masqué"), dans_cadre: false }] },
    { id: "10.8-zone", fleches: p("Avant la zone cachée"), tab: p("Lien masqué. Lien après la zone. Bouton après la zone"), focus_dans_zone: true }] };
  assert.deepStrictEqual(verifier(bon), []);
  const neuvy = structuredClone(bon); neuvy.cibles[0].annonce = vide; neuvy.cibles[0].etat_apres["aria-expanded"] = "false"; neuvy.cibles[4].tab = vide;
  assert.deepStrictEqual(verifier(neuvy), ["7.1-volet : focus non annoncé", "7.1-volet : l'activation n'a pas ouvert le volet", "10.8-zone : rien capturé au Tab",
    "10.8-zone : Tab n'atteint pas les liens (tabsToLinks Safari ?)"]);
  // VO muet : états DOM bons, `item` rempli (curseur VO) mais rien dit -> le banc doit échouer
  const muet = structuredClone(bon);
  for (const x of muet.cibles) for (const k of ["annonce", "annonce_demandee", "apres_activation", "fleches", "tab"]) if (x[k]) x[k] = { parole: [""], item: ["libellé button"] };
  assert.ok(verifier(muet).length >= 7, verifier(muet).join(" | "));
  // Neuvy 24/11 : le lecteur annonce le cadre puis lit ce qui le SUIT -> le banc doit échouer
  const dehors = structuredClone(bon); dehors.cibles[3].interieur = [{ ...p("Lien masqué"), dans_cadre: false }];
  assert.deepStrictEqual(verifier(dehors), ["4.13-cadre : Tab n'a pas parcouru les commandes du cadre (fait DOM)",
    "4.13-cadre : commande « Lecture » du cadre non restituée"]);
  assert.deepStrictEqual(verifier({ ...bon, focus_contenu: false }), ["page : focus système hors du document (interface du navigateur)"]);
  assert.ok(verifier({ cibles: [] }).length >= 5);
  console.log("verifier.mjs : auto-test OK");
}
