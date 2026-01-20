
import * as fs from 'fs';
import * as path from 'path';

/**
 * Provides a secure way to locate the PowerShell executable.
 * To prevent path hijacking attacks, it constructs an absolute path using the trusted
 * SystemRoot environment variable instead of relying on the system PATH.
 */
export class SafePowerShellPath {
    /**
     * Returns the absolute path to the PowerShell executable.
     * Uses the SystemRoot environment variable to construct the path securely.
     * Fallback to 'powershell.exe' if SystemRoot is not available (though highly unlikely on Windows).
     */
    public static getSafePath(): string {
        const systemRoot = process.env.SystemRoot;
        if (!systemRoot) {
            // Fallback to simple command if SystemRoot missing (unlikely on valid Windows system)
            return 'powershell.exe';
        }

        // Standard PowerShell location: %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
        const psPath = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

        // Verify file existence to be sure
        if (fs.existsSync(psPath)) {
            // Wrap in quotes to handle potential spaces in path (though SystemRoot usually doesn't have spaces)
            return `"${psPath}"`;
        }

        return 'powershell.exe';
    }
}
