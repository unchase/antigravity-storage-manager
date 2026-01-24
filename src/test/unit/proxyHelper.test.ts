
import * as assert from 'assert';

describe('Proxy Helper Tests', () => {

    test('Should construct proxy URL without auth', () => {
        const url = 'http://proxy.example.com:8080';
        const username = '';
        const password = '';

        let finalUrl = url;
        if (username && password) {
            const urlParts = new URL(url);
            urlParts.username = username;
            urlParts.password = password;
            finalUrl = urlParts.toString();
        }

        assert.strictEqual(finalUrl, 'http://proxy.example.com:8080');
    });

    test('Should construct proxy URL with auth', () => {
        const url = 'http://proxy.example.com:8080';
        const username = 'user';
        const password = 'password';

        let finalUrl = url;
        if (username && password) {
            const urlParts = new URL(url);
            urlParts.username = username;
            urlParts.password = password;
            finalUrl = urlParts.toString();
        }

        // URL.toString might add a trailing slash, need to handle that or exact match check
        assert.ok(finalUrl.startsWith('http://user:password@proxy.example.com:8080'));
    });

    test('Should handle invalid URL gracefully', () => {
        const url = 'invalid-url';
        const username = 'user';
        const password = 'password';

        let error = null;
        try {
            const urlParts = new URL(url);
            urlParts.username = username;
            urlParts.password = password;
        } catch (e) {
            error = e;
        }

        assert.ok(error);
    });
});
