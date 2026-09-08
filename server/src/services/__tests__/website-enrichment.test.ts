import { describe, expect, it } from 'vitest';

import {
  extractContactDetailsFromHtml,
  extractPublicOpportunitySignals,
} from '../website-enrichment';

describe('extractContactDetailsFromHtml', () => {
  it('extracts emails and US phones from mailto, tel, visible text, and JSON-LD', () => {
    const html = `
      <html>
        <body>
          <a href="mailto:hello@exampledental.com">Email us</a>
          <a href="tel:+15125550111">Call us</a>
          <a href="https://www.facebook.com/exampledental">Facebook</a>
          <a href="https://instagram.com/exampledental?utm_source=website">Instagram</a>
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

    const extracted = extractContactDetailsFromHtml(html, 'https://exampledental.com/contact');

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
    expect(extracted.socialUrls).toEqual(
      expect.arrayContaining([
        'https://www.facebook.com/exampledental',
        'https://instagram.com/exampledental?utm_source=website',
      ]),
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

  it('extracts contacts from nested JSON-LD contact points', () => {
    const html = `
      <script type="application/ld+json">
        {
          "@context": "https://schema.org",
          "@type": "Organization",
          "name": "Austin Trade Group",
          "contactPoint": [
            {
              "@type": "ContactPoint",
              "telephone": "+1 512 555 0444",
              "email": "office@austintradegroup.com"
            }
          ]
        }
      </script>
    `;

    const extracted = extractContactDetailsFromHtml(html);

    expect(extracted.emails).toContain('office@austintradegroup.com');
    expect(extracted.phones).toContain('+1 512 555 0444');
  });

  it('extracts only explicitly published decision-maker names', () => {
    const html = [
      '<html><body>',
      '<p>Owner: Jane Doe</p>',
      '<section class="team-member"><h3>Ravi Patel</h3><p>Chief Executive Officer</p></section>',
      '<script type="application/ld+json">',
      '{"@context":"https://schema.org","@type":"LocalBusiness","name":"Example Dental","founder":{"@type":"Person","name":"Morgan Lee","jobTitle":"Founder"}}',
      '</script>',
      '</body></html>',
    ].join('');

    const extracted = extractContactDetailsFromHtml(html, 'https://exampledental.com/about');

    expect(extracted.decisionMakers).toEqual(
      expect.arrayContaining([
        { name: 'Jane Doe', role: 'Owner' },
        { name: 'Ravi Patel', role: 'Chief Executive Officer' },
        { name: 'Morgan Lee', role: 'Founder' },
      ]),
    );
    expect(extracted.decisionMakers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Example Dental' })]),
    );
  });

  it('labels conservative public opportunity signals without extracting private data', () => {
    const signals = extractPublicOpportunitySignals(
      'Now hiring technicians. Expanding to a new location. Request a free estimate today.',
    );

    expect(signals).toEqual([
      'Public hiring signal',
      'Public growth signal',
      'Public active-service CTA',
    ]);
  });
});
