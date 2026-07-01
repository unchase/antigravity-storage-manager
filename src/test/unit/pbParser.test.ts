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

    test('extractStrings should find strings in .db file via extractStringsFromDb', async () => {
        const dbFile = path.join(tempDir, 'test.db');
        // Construct a buffer resembling a SQLite file
        const header = Buffer.from('SQLite format 3\x00');
        const trash1 = Buffer.from([0, 1, 2, 8, 11, 12, 14, 31, 127]);
        const str1 = Buffer.from('Test message 1 from SQLite');
        const trash2 = Buffer.from([0, 0, 5, 0]);
        const str2 = Buffer.from('Привет из базы данных 2');
        const trash3 = Buffer.from([0]);
        
        const dbBuffer = Buffer.concat([header, trash1, str1, trash2, str2, trash3]);
        fs.writeFileSync(dbFile, dbBuffer);
        
        const strings = await PbParser.extractStrings(dbFile);
        expect(strings).toContain('SQLite format 3');
        expect(strings).toContain('Test message 1 from SQLite');
        expect(strings).toContain('Привет из базы данных 2');
        expect(strings.length).toBeGreaterThanOrEqual(3);
    });

    test('searchInFolder should find matches in both .pb and .db files', async () => {
        // test.pb has 'Hello World'
        // Let's write a test.db that has 'Hello from DB'
        const dbFile = path.join(tempDir, 'another.db');
        const header = Buffer.from('SQLite format 3\x00');
        const str = Buffer.from('Hello from DB');
        const dbBuffer = Buffer.concat([header, str]);
        fs.writeFileSync(dbFile, dbBuffer);

        const results = await PbParser.searchInFolder(tempDir, 'Hello');
        // Should find both test.pb and another.db
        expect(results.length).toBe(2);
        const fileNames = results.map(r => r.fileName);
        expect(fileNames).toContain('test.pb');
        expect(fileNames).toContain('another.db');
    });
});
