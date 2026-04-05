import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PbParser } from './quota/pbParser';

/**
 * Exports conversation data (.pb + brain artifacts) to readable Markdown format.
 * Issue #16: Feature Request — Backup conversations as .md files
 */
export class MarkdownExporter {

    /**
     * Export a single conversation to a Markdown file.
     * Combines .pb conversation data with brain/ artifacts.
     */
    static async exportConversation(
        conversationId: string,
        conversationTitle: string,
        brainDir: string,
        convDir: string,
        outputPath: string
    ): Promise<string> {
        const lines: string[] = [];

        // Header
        lines.push(`# ${conversationTitle || conversationId}`);
        lines.push('');
        lines.push(`> Exported from Antigravity Storage Manager on ${new Date().toLocaleString()}`);
        lines.push(`> Conversation ID: \`${conversationId}\``);
        lines.push('');
        lines.push('---');
        lines.push('');

        // 1. Extract conversation messages from .pb file
        const pbFile = path.join(convDir, `${conversationId}.pb`);
        if (fs.existsSync(pbFile)) {
            lines.push('## Conversation Messages');
            lines.push('');

            try {
                const strings = await PbParser.extractStrings(pbFile);
                const messages = MarkdownExporter.groupAsMessages(strings);

                if (messages.length > 0) {
                    for (const msg of messages) {
                        lines.push(msg);
                        lines.push('');
                    }
                } else {
                    // Fallback: output raw extracted strings
                    lines.push('*Raw extracted content:*');
                    lines.push('');
                    for (const str of strings) {
                        if (str.trim().length > 2) {
                            lines.push(str);
                            lines.push('');
                        }
                    }
                }
            } catch (e: any) {
                lines.push(`*Failed to parse .pb file: ${e.message}*`);
                lines.push('');
            }
        }

        // 2. Include brain/ artifacts (task.md, walkthrough.md, etc.)
        const brainPath = path.join(brainDir, conversationId);
        if (fs.existsSync(brainPath)) {
            const artifacts = MarkdownExporter.collectArtifacts(brainPath);

            if (artifacts.length > 0) {
                lines.push('---');
                lines.push('');
                lines.push('## Artifacts');
                lines.push('');

                for (const artifact of artifacts) {
                    const relativePath = path.relative(brainPath, artifact.path);
                    lines.push(`### ${relativePath}`);
                    lines.push('');

                    if (artifact.isMarkdown) {
                        lines.push(artifact.content);
                    } else {
                        lines.push('```');
                        lines.push(artifact.content);
                        lines.push('```');
                    }
                    lines.push('');
                }
            }
        }

        const content = lines.join('\n');
        fs.writeFileSync(outputPath, content, 'utf8');
        return outputPath;
    }

    /**
     * Export multiple conversations to a directory with individual .md files.
     */
    static async exportMultiple(
        conversations: Array<{ id: string; title: string }>,
        brainDir: string,
        convDir: string,
        outputDir: string,
        progress?: vscode.Progress<{ message?: string; increment?: number }>,
        token?: vscode.CancellationToken
    ): Promise<{ exported: number; errors: string[] }> {
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        let exported = 0;
        const errors: string[] = [];
        const increment = 100 / conversations.length;

        for (const conv of conversations) {
            if (token?.isCancellationRequested) break;

            progress?.report({
                message: conv.title || conv.id,
                increment
            });

            try {
                // Sanitize title for filename
                const safeTitle = (conv.title || conv.id)
                    .replace(/[<>:"/\\|?*]/g, '_')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .substring(0, 100);

                const outputPath = path.join(outputDir, `${safeTitle}.md`);
                await MarkdownExporter.exportConversation(
                    conv.id, conv.title, brainDir, convDir, outputPath
                );
                exported++;
            } catch (e: any) {
                errors.push(`${conv.title || conv.id}: ${e.message}`);
            }
        }

        return { exported, errors };
    }

    /**
     * Group raw protobuf strings into conversation-like message blocks.
     * Heuristic: look for role markers and group text accordingly.
     */
    private static groupAsMessages(strings: string[]): string[] {
        const messages: string[] = [];
        const filtered = strings.filter(s => {
            const t = s.trim();
            if (t.length < 3) return false;
            // Exclude UUIDs
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return false;
            // Exclude hex hashes
            if (/^[0-9a-f]{16,64}$/i.test(t)) return false;
            // Exclude paths/URLs that aren't content
            if (/^(file|https?):\/\//.test(t) && t.length < 200) return false;
            return true;
        });

        // Look for role-like patterns
        const rolePatterns = /^(human|user|assistant|ai|system|tool|claude|gemini|gpt)$/i;

        let currentRole = '';
        let currentBlock: string[] = [];

        for (const str of filtered) {
            if (rolePatterns.test(str.trim())) {
                // Flush previous block
                if (currentBlock.length > 0 && currentRole) {
                    const roleHeader = currentRole.charAt(0).toUpperCase() + currentRole.slice(1).toLowerCase();
                    messages.push(`### ${roleHeader}\n\n${currentBlock.join('\n\n')}`);
                }
                currentRole = str.trim();
                currentBlock = [];
            } else {
                currentBlock.push(str);
            }
        }

        // Flush last block
        if (currentBlock.length > 0) {
            if (currentRole) {
                const roleHeader = currentRole.charAt(0).toUpperCase() + currentRole.slice(1).toLowerCase();
                messages.push(`### ${roleHeader}\n\n${currentBlock.join('\n\n')}`);
            } else {
                // No roles detected — just output content
                messages.push(currentBlock.join('\n\n'));
            }
        }

        return messages;
    }

    /**
     * Collect text artifacts from a brain/ conversation directory.
     */
    private static collectArtifacts(
        dirPath: string,
        maxDepth: number = 3,
        currentDepth: number = 0
    ): Array<{ path: string; content: string; isMarkdown: boolean }> {
        const artifacts: Array<{ path: string; content: string; isMarkdown: boolean }> = [];

        if (currentDepth >= maxDepth || !fs.existsSync(dirPath)) return artifacts;

        // Skip system-generated directories to reduce noise
        const skipDirs = ['.system_generated', 'node_modules', '.git'];

        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);

                if (entry.isDirectory()) {
                    if (!skipDirs.includes(entry.name)) {
                        artifacts.push(...MarkdownExporter.collectArtifacts(fullPath, maxDepth, currentDepth + 1));
                    }
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    // Only include text-based artifacts
                    if (['.md', '.txt', '.json', '.yaml', '.yml', '.log'].includes(ext)) {
                        try {
                            const stats = fs.statSync(fullPath);
                            // Skip very large files
                            if (stats.size < 512 * 1024) { // 512KB limit
                                const content = fs.readFileSync(fullPath, 'utf8');
                                artifacts.push({
                                    path: fullPath,
                                    content,
                                    isMarkdown: ext === '.md'
                                });
                            }
                        } catch { /* skip unreadable files */ }
                    }
                }
            }
        } catch { /* skip unreadable directories */ }

        return artifacts;
    }
}
