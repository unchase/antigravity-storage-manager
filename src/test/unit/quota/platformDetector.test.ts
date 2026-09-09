let mockPlatform = 'win32';
let mockArch = 'x64';

jest.mock('os', () => {
    const actual = jest.requireActual('os');
    return {
        ...actual,
        platform: () => mockPlatform,
        arch: () => mockArch
    };
});

import { PlatformDetector } from '../../../quota/platformDetector';

describe('PlatformDetector', () => {
    describe('Windows', () => {
        beforeEach(() => {
            mockPlatform = 'win32';
        });

        test('returns language_server_windows_x64.exe on win32 x64', () => {
            mockArch = 'x64';
            const detector = new PlatformDetector();
            expect(detector.getProcessName()).toBe('language_server_windows_x64.exe');
            expect(detector.getProcessNames()).toEqual(['language_server_windows_x64.exe']);
        });

        test('returns language_server_windows_arm.exe on win32 arm64 with fallbacks', () => {
            mockArch = 'arm64';
            const detector = new PlatformDetector();
            expect(detector.getProcessName()).toBe('language_server_windows_arm.exe');
            expect(detector.getProcessNames()).toEqual([
                'language_server_windows_arm.exe',
                'language_server_windows_arm64.exe',
                'language_server_windows_x64.exe'
            ]);
        });
    });

    describe('macOS (darwin)', () => {
        beforeEach(() => {
            mockPlatform = 'darwin';
        });

        test('returns language_server_macos on darwin x64', () => {
            mockArch = 'x64';
            const detector = new PlatformDetector();
            expect(detector.getProcessName()).toBe('language_server_macos');
            expect(detector.getProcessNames()).toEqual(['language_server_macos']);
        });

        test('returns language_server_macos_arm on darwin arm64 with fallback', () => {
            mockArch = 'arm64';
            const detector = new PlatformDetector();
            expect(detector.getProcessName()).toBe('language_server_macos_arm');
            expect(detector.getProcessNames()).toEqual(['language_server_macos_arm', 'language_server_macos']);
        });
    });

    describe('Linux', () => {
        beforeEach(() => {
            mockPlatform = 'linux';
        });

        test('returns language_server_linux_x64 on linux x64', () => {
            mockArch = 'x64';
            const detector = new PlatformDetector();
            expect(detector.getProcessName()).toBe('language_server_linux_x64');
            expect(detector.getProcessNames()).toEqual(['language_server_linux_x64']);
        });

        test('returns language_server_linux_arm on linux arm64 with fallback', () => {
            mockArch = 'arm64';
            const detector = new PlatformDetector();
            expect(detector.getProcessName()).toBe('language_server_linux_arm');
            expect(detector.getProcessNames()).toEqual(['language_server_linux_arm', 'language_server_linux_x64']);
        });
    });
});
