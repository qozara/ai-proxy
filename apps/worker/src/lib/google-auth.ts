export interface GoogleUser {
    id: string;
    email: string;
    name: string;
    picture?: string;
}

/**
 * Validates a Google OAuth2 access token by querying the userinfo endpoint.
 * Zero-dependency implementation suitable for Cloudflare Workers & Node runtimes.
 */
export async function validateGoogleToken(token: string): Promise<GoogleUser> {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error('Invalid Google token');
    }

    const data = await response.json() as any;

    if (!data.sub && !data.id) {
        throw new Error('Malformed Google userinfo response');
    }

    return {
        id: data.sub || data.id,
        email: data.email,
        name: data.name || data.email?.split('@')[0] || 'User',
        picture: data.picture,
    };
}
