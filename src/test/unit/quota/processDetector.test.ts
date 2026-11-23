import { WindowsProcessDetector } from '../../../quota/windowsProcessDetector';
import { UnixProcessDetector } from '../../../quota/unixProcessDetector';

describe('Process Detectors (agy & language_server)', () => {
    describe('WindowsProcessDetector', () => {
        const detector = new WindowsProcessDetector();

        test('parses agy.exe --hub process with = flag syntax and --hub-port', () => {
            const stdout = JSON.stringify({
                ProcessId: 32960,
                CommandLine: 'C:\\Users\\test\\.gemini\\bin\\agy.exe --hub --hub-port=51877 --app_data_dir=antigravity --csrf_token=2d740184-53f4-4513-b775-31cd5cabe186 "--add-dir=e:\\repo"'
            });

            const result = detector.parseProcessInfo(stdout);
            expect(result).toEqual({
                pid: 32960,
                extensionPort: 51877,
                csrfToken: '2d740184-53f4-4513-b775-31cd5cabe186'
            });
        });

        test('selects --hub process with csrf_token when multiple agy.exe processes are running', () => {
            const stdout = JSON.stringify([
                {
                    ProcessId: 1001,
                    CommandLine: 'C:\\Users\\test\\.gemini\\bin\\agy.exe --app_data_dir=antigravity'
                },
                {
                    ProcessId: 2002,
                    CommandLine: 'C:\\Users\\test\\.gemini\\bin\\agy.exe --hub --hub-port=51877 --app_data_dir=antigravity --csrf_token=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
                }
            ]);

            const result = detector.parseProcessInfo(stdout);
            expect(result).toEqual({
                pid: 2002,
                extensionPort: 51877,
                csrfToken: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
            });
        });

        test('parses legacy language_server_windows_x64.exe process', () => {
            const stdout = JSON.stringify({
                ProcessId: 4512,
                CommandLine: '"C:\\Users\\test\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server_windows_x64.exe" --app_data_dir antigravity --extension_server_port 42100 --csrf_token 12345678-1234-1234-1234-1234567890ab'
            });

            const result = detector.parseProcessInfo(stdout);
            expect(result).toEqual({
                pid: 4512,
                extensionPort: 42100,
                csrfToken: '12345678-1234-1234-1234-1234567890ab'
            });
        });
    });

    describe('UnixProcessDetector', () => {
        const detector = new UnixProcessDetector('linux');

        test('parses agy --hub process with = flags and --hub-port', () => {
            const stdout = '12345 1000 /home/user/.gemini/bin/agy --hub --hub-port=51877 --app_data_dir=antigravity --csrf_token=abcdef01-2345-6789-abcd-ef0123456789';
            const result = detector.parseProcessInfo(stdout);
            expect(result).toMatchObject({
                pid: 12345,
                extensionPort: 51877,
                csrfToken: 'abcdef01-2345-6789-abcd-ef0123456789'
            });
        });

        test('parses legacy language_server process on unix', () => {
            const stdout = '9876 1000 /opt/antigravity/language_server_linux_x64 --app_data_dir antigravity --extension_server_port=43000 --csrf_token=11111111-2222-3333-4444-555555555555';
            const result = detector.parseProcessInfo(stdout);
            expect(result).toMatchObject({
                pid: 9876,
                extensionPort: 43000,
                csrfToken: '11111111-2222-3333-4444-555555555555'
            });
        });
    });
});

