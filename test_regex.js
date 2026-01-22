const fs = require('fs');
const path = require('path');
const os = require('os');

const homedir = os.homedir();
const brainDir = path.join(homedir, '.gemini/antigravity/brain');

async function check() {
    console.log(`Checking ${brainDir}`);
    const entries = await fs.promises.readdir(brainDir);

    for (const id of entries) {
        const dirPath = path.join(brainDir, id);
        const taskPath = path.join(dirPath, 'task.md');

        if (fs.existsSync(taskPath)) {
            console.log(`Found task.md in ${id}`);
            const content = await fs.promises.readFile(taskPath, 'utf8');
            console.log(`Content length: ${content.length}`);
            const match = content.match(/^#\s*(?:Task:?\s*)?(.+)$/im);
            if (match) {
                console.log(`MATCH: "${match[1].trim()}"`);
            } else {
                console.log(`NO MATCH`);
                console.log(`First 100 chars: ${JSON.stringify(content.slice(0, 100))}`);
            }
        }
    }
}

check();
