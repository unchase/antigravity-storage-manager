
import { describe, test, expect, jest } from '@jest/globals';

// Mock vscode module
jest.mock('vscode', () => {
    return {
        workspace: {
            getConfiguration: () => ({
                get: () => 'en'
            })
        },
        env: {
            language: 'en'
        }
    };
}, { virtual: true });

// Mock LocalizationManager
jest.mock('../../l10n/localizationManager', () => {
    return {
        LocalizationManager: {
            getInstance: () => ({
                t: (str: string, ...args: any[]) => {
                    // Basic mock for formatRelativeTime
                    if (args.length > 0) {
                        return str.replace('{0}', args[0]);
                    }
                    return str;
                },
                getLocale: () => 'en-US'
            })
        }
    };
});

import * as utils from '../../utils';

describe('Conversation Utils Test Suite', () => {

    test('formatRelativeTime returns "Just now" for current time', () => {
        const now = new Date();
        expect(utils.formatRelativeTime(now)).toBe('Just now');
    });

    test('formatRelativeTime returns "5 mins ago" for 5 minutes ago', () => {
        const now = new Date();
        const fiveMinsAgo = new Date(now.getTime() - 5 * 60 * 1000);
        expect(utils.formatRelativeTime(fiveMinsAgo)).toBe('5 mins ago');
    });

});
