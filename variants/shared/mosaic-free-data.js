// Mosaïque éclatante, mode "libre" : pas de WALL_PATTERN fixe. Chaque tuile transférée en fin de
// manche peut atterrir sur n'importe quelle colonne encore libre de sa ligne, à condition qu'aucune
// tuile de la même couleur n'existe déjà sur cette ligne OU sur cette colonne (contrainte de carré
// latin : une couleur au plus par ligne, une couleur au plus par colonne). Le calcul d'adjacence
// (scoreTilePlacement) et les bonus de fin de partie (computeEndGameBonuses) du jeu de base sont
// réutilisés tels quels : ils ne dépendent que de "cette case est occupée ou non", jamais de la
// raison pour laquelle elle l'est.

// colonnes encore valides pour poser `color` sur `row`, étant donné l'état actuel du mur
function freeWallValidColumns(wall, row, color){
  if (wall[row].includes(color)) return []; // déjà cette couleur sur la ligne -> tuile gaspillée
  const cols = [];
  for (let col = 0; col < 5; col++){
    if (wall[row][col] !== null) continue;
    if (wall.some(r => r[col] === color)) continue; // déjà cette couleur sur la colonne
    cols.push(col);
  }
  return cols;
}

// Parcourt les lignes de motifs complètes dans le MÊME ORDRE (0 -> 4) que endRoundForPlayerFreeWall
// et sur un CLONE du mur, en appelant `chooseColumn(row, color, validCols, workingWall)` (peut être
// async, ex: attendre un tap dans un modal) uniquement quand plusieurs colonnes sont encore valides.
// Crucial : ne pas calculer toutes les ambiguïtés à l'avance sur le mur d'origine — un choix sur une
// ligne peut invalider une colonne encore "libre" pour une ligne suivante (même couleur, même colonne,
// contrainte de carré latin). Simuler dans le même ordre avec la même mutation garantit que la map
// renvoyée reste valide telle quelle pour endRoundForPlayerFreeWall.
async function collectFreeWallColumnChoices(player, chooseColumn){
  const workingWall = player.wall.map(row => row.slice());
  const choices = {};
  for (let row = 0; row < player.patternLines.length; row++){
    const line = player.patternLines[row];
    if (line.count !== line.capacity || line.color === null) continue;
    const validCols = freeWallValidColumns(workingWall, row, line.color);
    if (validCols.length === 0) continue; // gaspillée, rien à choisir
    const col = validCols.length === 1 ? validCols[0] : await chooseColumn(row, line.color, validCols, workingWall);
    workingWall[row][col] = line.color;
    choices[row] = col;
  }
  return choices;
}

// équivalent de endRoundForPlayer (jeu de base) pour le mur libre. `columnChoices` : { [row]: col },
// typiquement le résultat de collectFreeWallColumnChoices ; lève une erreur si un choix manque ou
// n'est plus valide (ne devrait jamais arriver si columnChoices vient bien de collectFreeWallColumnChoices
// appelé sur ce même joueur juste avant, sans mutation du mur entre les deux).
function endRoundForPlayerFreeWall(player, round, columnChoices){
  const choices = columnChoices || {};
  const completed = [];
  let wallScore = 0;
  player.patternLines.forEach((line, row) => {
    if (line.count === line.capacity && line.color !== null){
      const validCols = freeWallValidColumns(player.wall, row, line.color);
      let col;
      if (validCols.length === 0){
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
      const points = scoreTilePlacement(player.wall, row, col);
      wallScore += points;
      completed.push({ row, color: line.color, col, points });
      line.color = null; line.count = 0;
    }
  });
  const floorPenalty = sumFloorPenalty(player.floorFilled);
  player.floorFilled = 0;
  player.hasFirstPlayerMarker = false;
  const rawDelta = wallScore + floorPenalty;
  const newTotal = Math.max(0, player.totalScore + rawDelta);
  player.roundHistory.push({ round, wallScore, floorPenalty, roundDelta:rawDelta, runningTotal:newTotal, completedLines:completed });
  player.totalScore = newTotal;
}
