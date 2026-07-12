// Copie exacte du moteur de score de index.html — voir le plan (plan file) : le score n'est jamais
// réécrit en SQL, uniquement en JS, pour ne maintenir les règles d'Azul qu'à un seul endroit logique
// (même si physiquement dupliqué entre les forks single-device et ce fichier multijoueur).
// Chargé via <script src="shared/scoring-engine.js"></script>, expose les mêmes noms en scope global.

// `symbol` : glyphe distinctif affiché sur chaque tuile (comme les motifs du jeu physique) pour
// que les 5 couleurs restent différenciables sans percevoir la couleur (daltonisme)
const COLORS = [
  { id:'B', label:'Bleu',      hex:'#2563eb', symbol:'✿' },
  { id:'Y', label:'Jaune',     hex:'#eab308', symbol:'★' },
  { id:'R', label:'Rouge',     hex:'#dc2626', symbol:'▲' },
  { id:'K', label:'Noir',      hex:'#27272a', symbol:'●' },
  { id:'W', label:'Turquoise', hex:'#06b6d4', symbol:'◆' },
];
const COLOR_MAP = Object.fromEntries(COLORS.map(c => [c.id, c]));

// motif fixe du mur : chaque ligne est une rotation cyclique de la précédente
const WALL_PATTERN = [
  ['B','Y','R','K','W'],
  ['W','B','Y','R','K'],
  ['K','W','B','Y','R'],
  ['R','K','W','B','Y'],
  ['Y','R','K','W','B'],
];
const FLOOR_PENALTIES = [-1,-1,-2,-2,-2,-3,-3];

function createPlayer(name){
  return {
    name,
    wall: Array.from({length:5}, () => Array(5).fill(null)),
    patternLines: Array.from({length:5}, (_, i) => ({ capacity:i+1, color:null, count:0 })),
    floorFilled: 0,
    hasFirstPlayerMarker: false,
    totalScore: 0,
    roundHistory: [],
    finalBonuses: null,
  };
}

function wallColumnFor(row, color){ return WALL_PATTERN[row].indexOf(color); }

function runLength(wall, row, col, dRow, dCol){
  let r = row, c = col, count = 0;
  while (r >= 0 && r < 5 && c >= 0 && c < 5 && wall[r][c] !== null){
    count++; r += dRow; c += dCol;
  }
  return count;
}

function scoreTilePlacement(wall, row, col){
  const hRun = runLength(wall,row,col,0,1) + runLength(wall,row,col,0,-1) - 1;
  const vRun = runLength(wall,row,col,1,0) + runLength(wall,row,col,-1,0) - 1;
  if (hRun > 1 && vRun > 1) return hRun + vRun;
  if (hRun > 1) return hRun;
  if (vRun > 1) return vRun;
  return 1;
}

function sumFloorPenalty(filledCount, penalties){
  return (penalties || FLOOR_PENALTIES).slice(0, filledCount).reduce((s,v) => s+v, 0);
}

// floorFilled ne compte que les TUILES : le jeton premier joueur occupe une case de plancher en
// plus au moment du décompte (les deux étaient fusionnés avant, ce qui permettait à un décochage
// du jeton de "voler" une vraie tuile quand le plancher était déjà plein au moment du cochage).
function effectiveFloorCount(player){
  return Math.min(player.floorFilled + (player.hasFirstPlayerMarker ? 1 : 0), FLOOR_PENALTIES.length);
}

function endRoundForPlayer(player, round){
  const completed = [];
  const discarded = [];
  let wallScore = 0;
  player.patternLines.forEach((line, row) => {
    if (line.count === line.capacity && line.color !== null){
      const col = wallColumnFor(row, line.color);
      if (player.wall[row][col] !== null){
        // couleur déjà posée sur cette ligne du mur (ne peut venir que d'un scan mal corrigé :
        // la saisie manuelle bloque ce placement) — tracé dans l'historique, pas silencieux
        discarded.push({ row, color: line.color });
        line.color = null; line.count = 0;
        return;
      }
      player.wall[row][col] = line.color;
      const points = scoreTilePlacement(player.wall, row, col);
      wallScore += points;
      completed.push({ row, color:line.color, col, points });
      line.color = null; line.count = 0;
    }
  });
  const floorPenalty = sumFloorPenalty(effectiveFloorCount(player));
  player.floorFilled = 0;
  player.hasFirstPlayerMarker = false;
  const rawDelta = wallScore + floorPenalty;
  // le total cumulé ne peut jamais descendre sous 0 (règle officielle) ; on clampe le cumul, pas le delta de la manche
  const newTotal = Math.max(0, player.totalScore + rawDelta);
  player.roundHistory.push({ round, wallScore, floorPenalty, roundDelta:rawDelta, runningTotal:newTotal, completedLines:completed, discardedLines:discarded });
  player.totalScore = newTotal;
}

function computeEndGameBonuses(player){
  const wall = player.wall;
  let rows = 0, cols = 0, colors = 0;
  for (let r = 0; r < 5; r++) if (wall[r].every(c => c !== null)) rows++;
  for (let c = 0; c < 5; c++) if (wall.every(row => row[c] !== null)) cols++;
  for (const color of COLORS.map(c => c.id)){
    let count = 0;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (wall[r][c] === color) count++;
    if (count === 5) colors++;
  }
  const bonusPoints = rows*2 + cols*7 + colors*10;
  player.finalBonuses = { rows, cols, colors, bonusPoints };
  player.totalScore += bonusPoints;
}

// ================================================================
// -- Mosaïque éclatante : additif, ne modifie aucune des fonctions ci-dessus. game_mode :
// 'base' (défaut, mur fixe WALL_PATTERN), 'mosaic_free' (mur entièrement libre),
// 'mosaic_a'/'mosaic_b' (mur libre sauf 5 cases imprimées à couleur imposée — face 1 : ×2 sur
// ces cases ; face 2 : bonus de fin de partie augmentés). Ce fichier est la seule implémentation.
// ================================================================

// Faces 1 et 2 : le mur est LIBRE (mêmes règles que mosaic_free) à l'exception de 5 cases
// imprimées dont la couleur est imposée. [row, col, couleur], 0-indexé.
// Face 1 : les 5 cases imprimées portent en plus un ×2 sur le score de la pose.
// Face 2 : pose normale partout, mais bonus de fin de partie augmentés (MOSAIC_BONUSES).
const MOSAIC_FIXED_CELLS = {
  mosaic_a: [[0,3,'K'],[1,0,'W'],[2,2,'Y'],[3,4,'B'],[4,1,'R']],
  mosaic_b: [[1,1,'B'],[1,3,'R'],[2,2,'W'],[3,1,'K'],[3,3,'Y']],
};
const MOSAIC_BONUSES = {
  base:        { row: 2, col: 7,  color: 10 },
  mosaic_free: { row: 2, col: 7,  color: 10 },
  mosaic_a:    { row: 2, col: 7,  color: 10 },
  mosaic_b:    { row: 3, col: 10, color: 12 },
};

// plancher imprimé sur le plateau des faces 1/2 : une case neutre (0) en 2e position et des
// pénalités réparties différemment du jeu de base
const MOSAIC_FLOOR_PENALTIES = [-1, 0, -1, -2, -1, -2, -3];

function floorPenaltiesFor(gameMode){
  return (gameMode === 'mosaic_a' || gameMode === 'mosaic_b') ? MOSAIC_FLOOR_PENALTIES : FLOOR_PENALTIES;
}

// couleur imprimée sur la case (row, col) pour ce mode, ou null si case libre
function mosaicPrintedCellAt(gameMode, row, col){
  const cells = MOSAIC_FIXED_CELLS[gameMode];
  if (!cells) return null;
  const hit = cells.find(([r, c]) => r === row && c === col);
  return hit ? hit[2] : null;
}

// Face 1 : le ×2 est porté par les 5 cases imprimées
function mosaicMultiplierFor(gameMode, row, col){
  if (gameMode !== 'mosaic_a') return 1;
  return mosaicPrintedCellAt('mosaic_a', row, col) ? 2 : 1;
}

// équivalent de endRoundForPlayer pour le mur fixe WALL_PATTERN (mode 'base' uniquement — tous
// les modes Mosaïque passent par endRoundForPlayerChoiceWall ci-dessous)
function endRoundForPlayerFixedWall(player, round, gameMode){
  const completed = [];
  const discarded = [];
  let wallScore = 0;
  player.patternLines.forEach((line, row) => {
    if (line.count === line.capacity && line.color !== null){
      const col = wallColumnFor(row, line.color);
      if (player.wall[row][col] !== null){
        discarded.push({ row, color: line.color });
        line.color = null; line.count = 0;
        return;
      }
      player.wall[row][col] = line.color;
      const points = scoreTilePlacement(player.wall, row, col) * mosaicMultiplierFor(gameMode, row, col);
      wallScore += points;
      completed.push({ row, color:line.color, col, points });
      line.color = null; line.count = 0;
    }
  });
  const floorPenalty = sumFloorPenalty(effectiveFloorCount(player));
  player.floorFilled = 0;
  player.hasFirstPlayerMarker = false;
  const rawDelta = wallScore + floorPenalty;
  const newTotal = Math.max(0, player.totalScore + rawDelta);
  player.roundHistory.push({ round, wallScore, floorPenalty, roundDelta:rawDelta, runningTotal:newTotal, completedLines:completed, discardedLines:discarded });
  player.totalScore = newTotal;
}

// mur libre (mosaic_free) : pas de WALL_PATTERN, contrainte "au plus 1 tuile de chaque couleur par
// ligne et par colonne" (carré latin). Le joueur choisit la colonne d'arrivée avant de passer "Prêt"
// (voir player.html) ; les choix sont stockés dans players.pending_column_choices ({row: col}).
function freeWallValidColumns(wall, row, color){
  if (wall[row].includes(color)) return [];
  const cols = [];
  for (let col = 0; col < 5; col++){
    if (wall[row][col] !== null) continue;
    if (wall.some(r => r[col] === color)) continue;
    cols.push(col);
  }
  return cols;
}

// Faces 1/2 : mur libre + cases imprimées. Une case imprimée ne peut recevoir QUE sa couleur.
// Si la case imprimée de `color` est sur cette ligne (encore vide), c'est sa destination
// obligatoire ; et une colonne contenant la case imprimée (encore vide) de `color` sur une AUTRE
// ligne lui est réservée — sinon la case imprimée deviendrait définitivement injouable.
function mosaicWallValidColumns(gameMode, wall, row, color){
  const fixed = MOSAIC_FIXED_CELLS[gameMode] || [];
  if (wall[row].includes(color)) return [];
  const printedHere = fixed.find(([r, c, cc]) => r === row && cc === color);
  if (printedHere && wall[printedHere[0]][printedHere[1]] === null){
    const col = printedHere[1];
    return wall.some(rw => rw[col] === color) ? [] : [col];
  }
  const cols = [];
  for (let col = 0; col < 5; col++){
    if (wall[row][col] !== null) continue;
    if (wall.some(r => r[col] === color)) continue;
    const printed = mosaicPrintedCellAt(gameMode, row, col);
    if (printed && printed !== color) continue;
    if (fixed.some(([r, c, cc]) => c === col && cc === color && r !== row && wall[r][c] === null)) continue;
    cols.push(col);
  }
  return cols;
}

// colonnes valides pour poser `color` sur `row`, selon le mode de jeu
function wallValidColumnsByMode(gameMode, wall, row, color){
  if (gameMode === 'mosaic_free') return freeWallValidColumns(wall, row, color);
  if (gameMode === 'mosaic_a' || gameMode === 'mosaic_b') return mosaicWallValidColumns(gameMode, wall, row, color);
  const col = wallColumnFor(row, color);
  return wall[row][col] === null ? [col] : [];
}

// modes où le joueur choisit la colonne d'arrivée en fin de manche
function gameModeHasColumnChoice(gameMode){
  return gameMode === 'mosaic_free' || gameMode === 'mosaic_a' || gameMode === 'mosaic_b';
}

// Parcourt les lignes de motifs complètes dans le MÊME ORDRE (0 -> 4) que endRoundForPlayerChoiceWall
// et sur un CLONE du mur, en appelant `chooseColumn(row, color, validCols, workingWall)` (peut être
// async) uniquement quand plusieurs colonnes sont encore valides. Ne pas précalculer toutes les
// ambiguïtés sur le mur d'origine : un choix sur une ligne peut invalider une colonne encore "libre"
// pour une ligne suivante — simuler dans le même ordre garantit que la map renvoyée reste valide
// telle quelle pour endRoundForPlayerChoiceWall.
async function collectColumnChoices(gameMode, player, chooseColumn){
  const workingWall = player.wall.map(row => row.slice());
  const choices = {};
  for (let row = 0; row < player.patternLines.length; row++){
    const line = player.patternLines[row];
    if (line.count !== line.capacity || line.color === null) continue;
    const validCols = wallValidColumnsByMode(gameMode, workingWall, row, line.color);
    if (validCols.length === 0) continue;
    const col = validCols.length === 1 ? validCols[0] : await chooseColumn(row, line.color, validCols, workingWall);
    workingWall[row][col] = line.color;
    choices[row] = col;
  }
  return choices;
}

// fin de manche pour tous les modes à mur libre (mosaic_free, mosaic_a, mosaic_b) — le ×2 de la
// face 1 s'applique via mosaicMultiplierFor quand la tuile atterrit sur une case imprimée
function endRoundForPlayerChoiceWall(player, round, gameMode, columnChoices){
  const choices = columnChoices || {};
  const completed = [];
  const discarded = [];
  let wallScore = 0;
  player.patternLines.forEach((line, row) => {
    if (line.count === line.capacity && line.color !== null){
      const validCols = wallValidColumnsByMode(gameMode, player.wall, row, line.color);
      let col;
      if (validCols.length === 0){
        discarded.push({ row, color: line.color });
        line.color = null; line.count = 0;
        return;
      } else if (validCols.length === 1){
        col = validCols[0];
      } else {
        col = choices[row];
        if (col === undefined || !validCols.includes(col)){
          throw new Error(`Choix de colonne manquant ou invalide pour la ligne ${row+1}`);
        }
      }
      player.wall[row][col] = line.color;
      const points = scoreTilePlacement(player.wall, row, col) * mosaicMultiplierFor(gameMode, row, col);
      wallScore += points;
      completed.push({ row, color: line.color, col, points });
      line.color = null; line.count = 0;
    }
  });
  const floorPenalty = sumFloorPenalty(effectiveFloorCount(player), floorPenaltiesFor(gameMode));
  player.floorFilled = 0;
  player.hasFirstPlayerMarker = false;
  const rawDelta = wallScore + floorPenalty;
  const newTotal = Math.max(0, player.totalScore + rawDelta);
  player.roundHistory.push({ round, wallScore, floorPenalty, roundDelta:rawDelta, runningTotal:newTotal, completedLines:completed, discardedLines:discarded });
  player.totalScore = newTotal;
}

function endRoundForPlayerByMode(player, round, gameMode, columnChoices){
  if (gameModeHasColumnChoice(gameMode)) endRoundForPlayerChoiceWall(player, round, gameMode, columnChoices);
  else endRoundForPlayerFixedWall(player, round, gameMode);
}

function computeEndGameBonusesByMode(player, gameMode){
  const wall = player.wall;
  let rows = 0, cols = 0, colors = 0;
  for (let r = 0; r < 5; r++) if (wall[r].every(c => c !== null)) rows++;
  for (let c = 0; c < 5; c++) if (wall.every(row => row[c] !== null)) cols++;
  for (const color of COLORS.map(c => c.id)){
    let count = 0;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (wall[r][c] === color) count++;
    if (count === 5) colors++;
  }
  const b = MOSAIC_BONUSES[gameMode] || MOSAIC_BONUSES.base;
  const bonusPoints = rows*b.row + cols*b.col + colors*b.color;
  player.finalBonuses = { rows, cols, colors, bonusPoints };
  player.totalScore += bonusPoints;
}
