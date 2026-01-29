import * as protobuf from 'protobufjs';
import * as fs from 'fs';
import * as path from 'path';

export interface PbSearchResult {
    filePath: string;
    fileName: string;
    matches: string[];
    timestamp?: number;
}

export class PbParser {
    /**
     * Extracts all valid UTF-8 strings from a binary protobuf file.
     * This traverses the raw fields without needing a specific schema.
     */
    /**
     * Extracts all valid UTF-8 strings from a binary protobuf file.
     * Use a heuristic recursive approach to find strings inside nested messages.
     */
    static async extractStrings(filePath: string): Promise<string[]> {
        return new Promise((resolve, reject) => {
            const stream = fs.createReadStream(filePath);
            const chunks: Buffer[] = [];

            stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            stream.on('error', (err) => reject(err));
            stream.on('end', () => {
                const buffer = Buffer.concat(chunks);
                const strings = PbParser.parseBuffer(buffer);
                resolve(strings);
            });
        });
    }

    private static parseBuffer(buffer: Buffer, depth: number = 0): string[] {
        const strings: string[] = [];
        // Safety limit for recursion
        if (depth > 10) return strings;

        const reader = protobuf.Reader.create(buffer);

        try {
            while (reader.pos < reader.len) {
                const tag = reader.uint32();
                const wireType = tag & 7;
                const fieldNumber = tag >>> 3;
                if (depth === 0) console.log(`[Depth 0] Field ${fieldNumber} WireType ${wireType} Pos ${reader.pos}`);

                if (wireType === 2) { // Length-delimited
                    const len = reader.uint32();
                    // Protect against huge allocations or invalid lengths
                    if (reader.pos + len > reader.len) {
                        break; // Invalid
                    }

                    const payload = Buffer.from(reader.buf.slice(reader.pos, reader.pos + len));
                    reader.skip(len);

                    // Strategy:
                    // 1. Try to read as UTF-8 String
                    // 2. ALSO try to read as embedded message (recurse)
                    // We can accept both if they look valid, or prefer one.
                    // For "search" purposes, getting extra noise is better than missing data.

                    // Try String
                    // let foundLoginString = false;
                    try {
                        const str = payload.toString('utf8');
                        // Heuristic: Valid strings usually don't have too many control chars
                        // and are at least length 2.
                        // Regex: Printable chars + whitespace.
                        // But let's be permissive but filter obviously binary blobs.
                        // A simple check: if it has many null bytes or weird control chars, likely binary.
                        // For now, let's just keep it if it's > 2 chars and doesn't look like trash.
                        // eslint-disable-next-line no-control-regex
                        if (str.length > 2 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(str)) {
                            strings.push(str);
                            // foundLoginString = true; // unused
                        }
                    } catch { /* ignore error */ }

                    // Try Recursive Message
                    // Only recurse if we didn't firmly identify it as a simple string? 
                    // No, a string bytes could coincidentally look like a message, or vice versa.
                    // But usually a "Message" bytes won't look like a clean UTF-8 string (it will have tags).
                    // So if we found a clean string, maybe don't recurse?
                    // Actually, protobuf strings are just bytes. A string field IS bytes.
                    // A nested message field IS bytes.
                    // So we should try recursion mainly if it *doesn't* look like a clean string, 
                    // OR if we suspect it's a message.
                    // Let's always try recursion, but we need to identify if the recursion produced valid results.

                    const subStrings = PbParser.parseBuffer(payload, depth + 1);
                    if (subStrings.length > 0) {
                        strings.push(...subStrings);
                    }

                } else if (wireType === 0) { // Varint
                    try { reader.skipType(wireType); } catch { break; }
                } else if (wireType === 1) { // 64-bit
                    try { reader.skipType(wireType); } catch { break; }
                } else if (wireType === 5) { // 32-bit
                    try { reader.skipType(wireType); } catch { break; }
                } else {
                    // Invalid/Unknown wire type, probably not a message or we lost sync
                    // Verify if this level of parsing is invalid
                    // But we can't easily "return fail" here without refactoring.
                    // We just stop parsing this block.
                    break;
                }
            }
        } catch {
            // Ignore parse errors, just return what we matched so far
        }

        return strings;
    }

    static async searchInFolder(folderPath: string, query: string): Promise<PbSearchResult[]> {
        const results: PbSearchResult[] = [];
        if (!fs.existsSync(folderPath)) {
            return results;
        }

        const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.pb'));
        const queryLower = query.toLowerCase();

        for (const file of files) {
            const filePath = path.join(folderPath, file);
            try {
                const strings = await this.extractStrings(filePath);
                const matches = strings.filter(s => s.toLowerCase().includes(queryLower));

                if (matches.length > 0) {
                    // Try to extract timestamp from filename if possible (some systems name them by UUID, others might have metadata)
                    // For now, use file modification time
                    const stats = fs.statSync(filePath);

                    results.push({
                        filePath,
                        fileName: file,
                        matches: matches.slice(0, 5), // Limit sample matches
                        timestamp: stats.mtimeMs
                    });
                }
            } catch (error) {
                console.error(`Error parsing ${file}:`, error);
            }
        }

        return results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }

    /**
     * Attempts to extract a descriptive title/summary from a .pb file.
     */
    static async extractTitle(filePath: string): Promise<string | null> {
        try {
            if (!fs.existsSync(filePath)) return null;
            const strings = await this.extractStrings(filePath);

            // Heuristic to find the title:
            // 1. Exclude UUIDs, paths, very short strings, and technical IDs.
            // 2. Select the first string that looks like human text.
            const candidates = strings.filter(s => {
                const trimmed = s.trim();
                if (trimmed.length < 4 || trimmed.length > 200) return false;
                // Exclude UUIDs
                if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return false;
                // Exclude hex IDs
                if (/^[0-9a-f]{16,64}$/i.test(trimmed)) return false;
                // Exclude paths/URLs
                if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('://')) return false;

                return true;
            });

            if (candidates.length > 0) {
                // Often the first few strings are things like "Antigravity", "Cascade", etc.
                // We want to skip those if they appear as exact matches.
                const technical = ['antigravity', 'cascade', 'cortex', 'gemini', 'claude', 'gpt'];
                for (const candidate of candidates) {
                    if (!technical.includes(candidate.toLowerCase())) {
                        return candidate;
                    }
                }
                return candidates[0];
            }
        } catch (e) {
            console.error(`Failed to extract title from ${filePath}:`, e);
        }
        return null;
    }
}
