
/**
 * SVG icons for file types mimicking VS Code (Material Theme / Seti)
 * Inline SVG prevents CSP and loading issues in Webview
 */

// Colors
const C = {
    blue: '#519aba',
    yellow: '#cbcb41',
    green: '#8dc149',
    red: '#f55385',
    purple: '#a074c4',
    orange: '#e37933',
    gray: '#cccccc',
    darkBlue: '#519aba',
    lightBlue: '#84c1ff'
};

const icons: { [key: string]: string } = {
    // Default File
    file: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.gray}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`,

    // Markdown (Blue M)
    markdown: `<svg viewBox="0 0 16 16" fill="none"><path d="M14.5 2H1.5C0.67 2 0 2.67 0 3.5v9c0 0.83 0.67 1.5 1.5 1.5h13c0.83 0 1.5-0.67 1.5-1.5v-9c0-0.83-0.67-1.5-1.5-1.5zm-5 10H8V7.5L6.5 9 5 7.5V12H3.5V5c0-0.28 0.22-0.5 0.5-0.5h1l2 2.5 2-2.5h1c0.28 0 0.5 0.22 0.5 0.5v7zM14 6h-2v1h2v1h-2v1h2v1h-2.5V5H14v1z" fill="${C.blue}"/></svg>`,

    // JSON (Yellow {})
    json: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.yellow}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7c0-2 2-3 3-3h1"></path><path d="M9 20H7c-1 0-3-1-3-3"></path><path d="M12 4h2c2 0 3 2 3 4v2l2 2-2 2v2c0 2-1 4-3 4h-2"></path></svg>`,

    // Javascript (Yellow JS)
    javascript: `<svg viewBox="0 0 32 32"><path d="M0,0V32H32V0Z" fill="#f7df1e"/><path d="M6.6,24.6l3.4-2c0.8,1.4,1.8,2,3.3,2c1.4,0,2.3-0.7,2.3-1.7v-0.1c0-1.2-1-1.7-2.6-2.4l-0.9-0.4c-2.4-1.1-4-2.5-4-5.3v-0.1c0-2.8,2.2-4.9,5.2-4.9c2.2,0,4,1,5.2,3.1l-3.2,1.9c-0.6-1.1-1.3-1.6-2.2-1.6c-1.1,0-1.7,0.7-1.7,1.5v0.1c0,1,0.8,1.5,2.7,2.3l0.9,0.4c2.8,1.2,4.6,2.7,4.6,5.7v0.1c0,3-2.3,5.1-5.7,5.1C10,28.3,7.8,26.8,6.6,24.6z M22.7,28.1V9.9h4.3v18.2H22.7z" fill="#000"/></svg>`,

    // Typescript (Blue TS)
    typescript: `<svg viewBox="0 0 32 32"><path d="M0,0V32H32V0Z" fill="#007acc"/><path d="M16.5,15.5h-3.3v-3h10.9v3h-3.3v12.2h-4.3V15.5z M25.2,25.6c0.6,0.6,1.4,0.9,2.2,0.9c0.9,0,1.4-0.4,1.4-1.1v-0.1c0-0.7-0.4-1.1-1.8-1.7L26.3,23c-1.8-0.7-3-1.8-3-3.8v-0.1c0-2,1.6-3.6,3.9-3.6c1.6,0,2.9,0.7,3.8,2.2l-2.4,1.4c-0.4-0.8-0.9-1.1-1.5-1.1c-0.6,0-1,0.3-1,0.8v0.1c0,0.6,0.5,1,2,1.6l0.8,0.3c2.1,0.9,3.3,2,3.3,4.2v0.1c0,2.2-1.7,3.8-4.2,3.8c-1.8,0-3.2-0.8-4-2.3L25.2,25.6z" fill="#fff"/></svg>`,

    // Python (Blue/Yellow)
    python: `<svg viewBox="0 0 32 32"><path d="M15.9,2c-4,0-4.3,1.8-4.3,1.8l0.1,1.9h4.4v0.6h-6C6.5,6.3,5,8.1,5,10.6v3.1h3.1v-1c0,0,0-1.5,1.6-1.5h4.6c1.6,0,1.5,1.5,1.5,1.5v2.2h4.7v-2.8C20.5,8,19.3,2,15.9,2z M13.3,3.9c0.5,0,0.8,0.4,0.8,0.8s-0.3,0.8-0.8,0.8s-0.8-0.4-0.8-0.8S12.8,3.9,13.3,3.9z" fill="${C.blue}"/><path d="M16,30.1c4,0,4.3-1.8,4.3-1.8l-0.1-1.9h-4.4v-0.6h6c3.6,0,5.1-1.7,5.1-4.2v-3.1h-3.1v1c0,0,0,1.5-1.6,1.5h-4.6c-1.6,0-1.5-1.5-1.5-1.5v-2.2h-4.7v2.8C11.5,24.1,12.7,30.1,16,30.1z M18.7,28.2c-0.5,0-0.8-0.4-0.8-0.8s0.3-0.8,0.8-0.8s0.8,0.4,0.8,0.8S19.1,28.2,18.7,28.2z" fill="${C.yellow}"/></svg>`,

    // React (Blue Atom)
    react: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.lightBlue}" stroke-width="2"><circle cx="12" cy="12" r="3" fill="${C.lightBlue}"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></svg>`,

    // Image (Purple Media)
    image: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.purple}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,

    // Archive (Orange Zip)
    archive: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.orange}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,

    // Settings (Gray Gear)
    settings: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.gray}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,

    // Database (Green/Blue DB)
    database: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.green}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`,

    // HTML/Code (Orange)
    code: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.orange}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,

    // CSS (Blue)
    css: `<svg viewBox="0 0 24 24" fill="none" stroke="${C.blue}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2L2 22L12 24L22 22L20 2H4Z" stroke="none" fill="${C.blue}" opacity="0.2"/><path d="M7 6H17L16 16L12 17.5L8 16L7.5 12H11.5L11.7 13.5L12 13.7L12.3 13.5L12.5 10H6.5L6 8H18" stroke="${C.blue}"/></svg>`
};

export const getFileIconSvg = (filename: string): string => {
    const ext = filename.split('.').pop()?.toLowerCase();

    switch (ext) {
        // Documents
        case 'md': return icons.markdown;
        case 'txt': case 'log': return icons.file;

        // Data
        case 'json': return icons.json;
        case 'yaml': case 'yml': case 'toml': case 'ini': case 'conf': case 'env': return icons.settings;
        case 'pb': case 'sql': case 'db': case 'sqlite': return icons.database;
        case 'resolved': return icons.file;

        // Code
        case 'js': case 'cjs': case 'mjs': return icons.javascript;
        case 'ts': return icons.typescript;
        case 'jsx': case 'tsx': return icons.react;
        case 'py': case 'pyc': case 'pyd': return icons.python;
        case 'html': case 'htm': case 'xml': case 'svg': return icons.code;
        case 'css': case 'scss': case 'less': return icons.css;
        case 'c': case 'cpp': case 'h': case 'cs': case 'go': case 'rs': case 'php': return icons.code;

        // Media
        case 'jpg': case 'jpeg': case 'png': case 'gif': case 'webp': case 'bmp': case 'ico': return icons.image;

        // Archives
        case 'zip': case 'gz': case 'tar': case 'rar': case '7z': return icons.archive;

        default: return icons.file;
    }
};
