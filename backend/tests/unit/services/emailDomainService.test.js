const {
    domainOf,
    isDisposableDomain,
} = require('../../../services/emailDomainService');

describe('emailDomainService.domainOf', () => {
    it('returns the lowercased part after the last @', () => {
        expect(domainOf('Jane@Gmail.COM')).toBe('gmail.com');
        expect(domainOf('"odd@local"@proton.me')).toBe('proton.me');
    });

    it('reads the domain the mail is delivered to', () => {
        expect(domainOf('jane@mailinator.com(x)')).toBe('mailinator.com');
        expect(domainOf('<jane@mailinator.com>')).toBe('mailinator.com');
    });
});

describe('emailDomainService.isDisposableDomain', () => {
    it.each(['mailinator.com', 'yopmail.com', 'guerrillamail.com'])(
        'flags %s',
        (domain) => {
            expect(isDisposableDomain(domain)).toBe(true);
        }
    );

    it('flags a subdomain of a disposable provider', () => {
        expect(isDisposableDomain('inbox.mailinator.com')).toBe(true);
    });

    it.each(['gmail.com', 'outlook.com', 'proton.me', 'icloud.com', 'com'])(
        'leaves %s alone',
        (domain) => {
            expect(isDisposableDomain(domain)).toBe(false);
        }
    );
});

describe('canonicalEmail', () => {
    const { canonicalEmail } = require('../../../services/emailDomainService');

    it('folds Gmail dots, +tags and googlemail into one mailbox', () => {
        expect(canonicalEmail(' Jane.Doe+trial@GoogleMail.com ')).toBe(
            'janedoe@gmail.com'
        );
        expect(canonicalEmail('j.a.n.e.doe@gmail.com')).toBe(
            'janedoe@gmail.com'
        );
    });

    it('drops +tags but keeps dots elsewhere', () => {
        expect(canonicalEmail('first.last+x@fastmail.com')).toBe(
            'first.last@fastmail.com'
        );
    });

    // Each of these passes signup validation and Nodemailer delivers it to
    // jane@gmail.com, so it must not open a second account for that mailbox.
    it.each([
        '(x)jane@gmail.com',
        'jane(x)@gmail.com',
        'ja.ne+a(x)@gmail.com',
        '"jane"@gmail.com',
        '<jane@gmail.com>',
        '"x"<jane@gmail.com>',
        'x,jane@gmail.com',
        'g:jane@gmail.com;',
    ])('folds %s into the mailbox it is delivered to', (email) => {
        expect(canonicalEmail(email)).toBe('jane@gmail.com');
    });

    it('leaves odd input alone', () => {
        expect(canonicalEmail('+only@example.com')).toBe('+only@example.com');
        expect(canonicalEmail('')).toBeNull();
        expect(canonicalEmail('   ')).toBeNull();
        expect(canonicalEmail('  nope  ')).toBe('nope');
    });
});
