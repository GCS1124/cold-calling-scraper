import { describe, expect, it } from 'vitest';

import { extractContactDetailsFromHtml } from '../website-enrichment';

describe('extractContactDetailsFromHtml', () => {
  it('extracts emails and US phones from mailto, tel, visible text, and JSON-LD', () => {
    const html = `
      <html>
        <body>
          <a href="mailto:hello@exampledental.com">Email us</a>
          <a href="tel:+15125550111">Call us</a>
          <p>Questions? support@exampledental.com or (512) 555-0222.</p>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "LocalBusiness",
              "email": "care@exampledental.com",
              "telephone": "+1 512 555 0333"
            }
          </script>
        </body>
      </html>
    `;

    const extracted = extractContactDetailsFromHtml(html);

    expect(extracted.emails).toEqual(
      expect.arrayContaining([
        'hello@exampledental.com',
        'support@exampledental.com',
        'care@exampledental.com',
      ]),
    );
    expect(extracted.phones).toEqual(
      expect.arrayContaining(['+1 512 555 0111', '+1 512 555 0222', '+1 512 555 0333']),
    );
  });

  it('does not glue navigation text onto adjacent visible email addresses', () => {
    const html = `
      <html>
        <body>
          <div class="contact">
            <span>Email us:</span>
            <span>info@parmerlaneortho.com</span>
            <nav>
              <a href="/home">Home</a>
              <a href="/about">About</a>
              <a href="/patients">Patients</a>
            </nav>
          </div>
        </body>
      </html>
    `;

    const extracted = extractContactDetailsFromHtml(html);

    expect(extracted.emails).toContain('info@parmerlaneortho.com');
    expect(extracted.emails).not.toContain('info@parmerlaneortho.comhomeaboutpatients');
  });
});
