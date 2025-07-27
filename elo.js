(function(){
  const BASE_K = 32;

  function calculateExpectedScore(playerElo, opponentElos) {
    return opponentElos.reduce((acc, opponentElo) => acc + 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400)), 0) / opponentElos.length;
  }

  function calculateActualScore(position, totalPlayers) {
    return (totalPlayers - position) / (totalPlayers - 1);
  }

  function calculateKFactor(totalPlayers, rounds = 50) {
    // Rundengewichtung: 20 → 0.5  |  75 → 1.0 (max.)
    const roundWeight = Math.min(1, Math.max(0.5, 0.5 + ((rounds - 20) / 55) * 0.5));
    // Spielergewichtung: 2 → 0.5  |  6 → 1.0 (max.)
    const playerWeight = Math.min(1, Math.max(0.5, (totalPlayers - 2) / 4 + 0.5));
    return Math.round(BASE_K * roundWeight * playerWeight);
  }

  window.Elo = { calculateExpectedScore, calculateActualScore, calculateKFactor };
})(); 