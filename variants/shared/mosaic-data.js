// Données de l'extension "Mosaïque éclatante" : réutilise le WALL_PATTERN standard tel quel (mêmes
// couleurs par position), pas de nouvelle grille. Seuls deux éléments changent selon la face jouée :
// - Face A : 5 cases précises portent un multiplicateur ×2 sur le score de la pose (adjacence normale,
//   juste doublée), les bonus de fin de partie restent ceux du jeu de base.
// - Face B : pose normale partout, mais les bonus de fin de partie sont augmentés.
const MOSAIC_FACE_A_MULTIPLIER_CELLS = [[0,3],[1,0],[2,2],[3,4],[4,1]]; // [row, col], 0-indexé comme WALL_PATTERN

const MOSAIC_BONUSES = {
  A: { row: 2, col: 7, color: 10 }, // identiques au jeu de base
  B: { row: 3, col: 10, color: 12 },
};

function mosaicIsMultiplierCell(row, col){
  return MOSAIC_FACE_A_MULTIPLIER_CELLS.some(([r,c]) => r === row && c === col);
}

function mosaicMultiplierFor(face, row, col){
  return (face === 'A' && mosaicIsMultiplierCell(row, col)) ? 2 : 1;
}
