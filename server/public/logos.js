// vector line-art logos for the game cards (stroke only, like the console draws them)
window.GAME_LOGOS = (() => {
  const wrap = (body) => `<svg class="glogo" viewBox="0 0 240 90" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const A = 'stroke="#9ff7ff"', B = 'stroke="#ffcf6e"';
  return {
    asteroids: wrap(`
      <path ${A} d="M118 18 L128 62 L118 54 L108 62 Z"/><path ${A} d="M113 56 L118 66 L123 56" opacity=".6"/>
      <path ${B} d="M30 22 L48 14 L66 24 L62 44 L44 52 L28 42 Z"/>
      <path ${B} d="M170 50 L186 40 L204 46 L208 64 L190 76 L172 68 Z"/>
      <path ${B} d="M206 14 L220 12 L224 24 L212 28 Z" opacity=".8"/>
      <path ${A} d="M118 12 L118 2" opacity=".7"/>`),
    lightcycles: wrap(`
      <path ${A} d="M14 70 L120 70 L120 28 L196 28"/><path ${A} d="M196 20 L224 28 L196 36 Z"/>
      <path ${B} d="M226 60 L150 60 L150 80 L64 80"/><path ${B} d="M52 72 L24 80 L52 88 Z" transform="translate(0 -1)"/>
      <path ${A} d="M120 70 L120 28" opacity=".35"/>`),
    vecstrike: wrap(`
      <circle ${B} cx="120" cy="45" r="26"/><path ${B} d="M120 8 V30 M120 60 V82 M83 45 H104 M136 45 H157"/><circle ${B} cx="120" cy="45" r="2"/>
      <path ${A} d="M36 74 L52 40 L68 74 L52 66 Z"/><path ${A} d="M186 30 L204 24 L212 36 L196 46 Z" opacity=".85"/>
      <path ${A} d="M70 58 L100 48" opacity=".5"/>`),
    boostball: wrap(`
      <path ${A} d="M34 56 L60 46 L88 46 L98 56 L88 66 L60 66 Z"/><path ${A} d="M60 46 L56 40 M60 66 L56 72" opacity=".7"/>
      <path ${B} d="M8 52 L24 52 M2 58 L22 58 M8 64 L24 64" opacity=".7"/>
      <path ${B} d="M146 36 l10 -3 l9 5 l1 10 l-8 7 l-10 -3 l-3 -9 z"/>
      <path ${B} d="M180 30 L224 22 M184 44 L222 40 M178 52 L212 60" opacity=".45"/>
      <path ${A} d="M104 56 L136 50" opacity=".5"/>`),
  };
})();
