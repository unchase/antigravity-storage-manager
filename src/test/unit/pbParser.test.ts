import * as protobuf from 'protobufjs';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PbParser } from '../../quota/pbParser';

describe('PbParser', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbparser-test-'));
    const testFile = path.join(tempDir, 'test.pb');

    beforeAll(() => {
        // Create a dummy protobuf file manually
        // Field 1: String "Hello World"
        // Field 2: Varint 123
        // Field 3: String "Another string"

        const writer = protobuf.Writer.create();
        writer.uint32((1 << 3) | 2).string("Hello World");
        writer.uint32((2 << 3) | 0).int32(123);
        writer.uint32((3 << 3) | 2).string("Another string with special chars: 🤖");

        const buffer = writer.finish();
        fs.writeFileSync(testFile, buffer);
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('extractStrings should find all string fields', async () => {
        const strings = await PbParser.extractStrings(testFile);
        expect(strings).toContain('Hello World');
        expect(strings).toContain('Another string with special chars: 🤖');
        expect(strings.length).toBeGreaterThanOrEqual(2);
    });

    test('searchInFolder should find the file when query matches', async () => {
        const results = await PbParser.searchInFolder(tempDir, 'Hello');
        expect(results).toHaveLength(1);
        expect(results[0].fileName).toBe('test.pb');
        expect(results[0].matches).toContain('Hello World');
    });

    test('searchInFolder should return empty if query does not match', async () => {
        const results = await PbParser.searchInFolder(tempDir, 'NonExistent');
        expect(results).toHaveLength(0);
    });
});
