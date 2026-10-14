import './ui/styles.css';
import { Game } from './game/game';

// Fonts load at runtime so the single-file build keeps the external stylesheet link.
const fonts = document.createElement('link');
fonts.rel = 'stylesheet';
fonts.href =
  'https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@500;700&family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@500;600;700&display=swap';
document.head.appendChild(fonts);

new Game(document.getElementById('app')!).start();
