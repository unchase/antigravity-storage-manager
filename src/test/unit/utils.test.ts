import { formatRelativeTime } from '../../../src/utils';

describe('Utils', () => {
    describe('formatRelativeTime', () => {
        test('returns "Just now" for current time', () => {
            expect(formatRelativeTime(new Date())).toBe('Just now');
        });

        test('returns "mins ago" correctly', () => {
            const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);
            expect(formatRelativeTime(fiveMinsAgo)).toBe('5 mins ago');
        });

        test('returns "1 hour ago" correctly', () => {
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000 - 1000);
            expect(formatRelativeTime(oneHourAgo)).toBe('1 hour ago');
        });

        test('returns "days ago" correctly', () => {
            const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 - 1000);
            expect(formatRelativeTime(twoDaysAgo)).toBe('2 days ago');
        });

        test('returns date string for older dates', () => {
            const oldDate = new Date('2020-01-01');
            const result = formatRelativeTime(oldDate);
            // Result format depends on locale, but shouldn't contain "ago"
            expect(result).not.toContain('ago');
        });
    });
});
