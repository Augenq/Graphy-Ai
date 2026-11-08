// Register the actual Material Web custom elements. React 19 assigns their
// properties directly; no imitation controls or component wrapper library.
import '@material/web/icon/icon.js';
import '@material/web/list/list.js';
import '@material/web/list/list-item.js';
import '@material/web/divider/divider.js';
import '@material/web/ripple/ripple.js';
import '@material/web/focus/md-focus-ring.js';
import '@material/web/switch/switch.js';
import '@material/web/radio/radio.js';
import '@material/web/checkbox/checkbox.js';
import { styles as typescaleStyles } from '@material/web/typography/md-typescale-styles.js';
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-500.css';
import '@fontsource/roboto/latin-700.css';
import '@fontsource/roboto/cyrillic-400.css';
import '@fontsource/roboto/cyrillic-500.css';
import '@fontsource/roboto/cyrillic-700.css';
import './assets/fonts/material-symbols-subset.css';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, typescaleStyles.styleSheet!];
