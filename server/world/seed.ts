// The seeded demo world: a small, fictional slice of the web, served by this app.
//
// Every company and page here is invented. The point is that the pages are real HTTP pages,
// so the Researcher reads them and the Skeptic re-fetches them exactly as it would on the
// public web. Pages can be taken down or edited, and new pages can be published, which is
// what lets a demo show a claim failing and a dormant lead waking up.

export interface SeedPage {
  path: string;
  kind: 'about' | 'team' | 'job' | 'news' | 'pricing';
  title: string;
  /** HTML body. One fact per sentence keeps extraction honest. */
  body: string;
  /** Publication date, in days before the moment the world is seeded. */
  daysAgo?: number;
  /** 0 = live from the start. 1, 2... = published later, one batch per ingest. */
  batch?: number;
  /** What happens to this page after the first crawl has read it. */
  afterCrawl?: { action: 'gone' } | { action: 'edit'; body: string };
}

export interface SeedSite {
  slug: string;
  name: string;
  domain: string;
  pages: SeedPage[];
}

const p = (...paragraphs: string[]) => paragraphs.map((t) => `<p>${t}</p>`).join('\n');
const people = (...rows: string[]) => `<ul class="people">\n${rows.map((r) => `<li>${r}</li>`).join('\n')}\n</ul>`;

export const SEED_SITES: SeedSite[] = [
  {
    slug: 'northbeam',
    name: 'Northbeam AI',
    domain: 'northbeam.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Northbeam AI',
        body: p(
          'Northbeam AI builds inference infrastructure that lets product teams ship large language model features without managing GPUs.',
          'We are a team of 140 people headquartered in San Francisco, California.',
        ),
      },
      {
        path: 'team',
        kind: 'team',
        title: 'Leadership',
        body: people(
          'Priya Raman, VP Engineering. Previously at Lumen Cloud and Hexaform. Email: priya.raman@northbeam.example',
          'Tom Becker, Head of Finance. Previously at Ardent Bank. Email: tom.becker@northbeam.example',
          'Elena Sokolova, Chief Executive Officer.',
        ),
      },
      {
        path: 'careers/senior-billing-engineer',
        kind: 'job',
        title: 'Senior Billing Engineer',
        daysAgo: 9,
        body: p(
          'Northbeam AI is hiring a Senior Billing Engineer to own our metering and invoicing pipeline.',
          'You will design usage metering for every inference call and replace our home-grown billing scripts.',
        ),
      },
      {
        path: 'news/series-b',
        kind: 'news',
        title: 'Northbeam AI closes Series B',
        daysAgo: 35,
        body: p(
          'Northbeam AI raises $42 million Series B led by Halcyon Ventures.',
          'The round will go toward expanding capacity and building an enterprise sales team.',
        ),
      },
    ],
  },
  {
    slug: 'quillstack',
    name: 'Quillstack',
    domain: 'quillstack.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Quillstack',
        body: p(
          'Quillstack makes developer tools for API documentation and SDK generation.',
          'Quillstack has 85 employees and is headquartered in Austin, Texas.',
        ),
      },
      {
        path: 'team',
        kind: 'team',
        title: 'Team',
        body: people(
          'Marcus Oyelaran, Head of Platform. Previously at Gridline. Email: marcus.oyelaran@quillstack.example',
          'Sara Lindqvist, Chief Technology Officer.',
        ),
      },
      {
        path: 'news/usage-pricing',
        kind: 'news',
        title: 'A new way to pay for Quillstack',
        daysAgo: 20,
        body: p(
          'Quillstack is moving to usage-based pricing for all API plans starting next quarter.',
          'Customers will pay per generated SDK build instead of per seat.',
        ),
      },
    ],
  },
  {
    slug: 'vectorly',
    name: 'Vectorly',
    domain: 'vectorly.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Vectorly',
        body: p(
          'Vectorly offers a managed vector database for machine learning teams.',
          'Our 60-person team is headquartered in Berlin, Germany.',
        ),
      },
      {
        path: 'team',
        kind: 'team',
        title: 'Team',
        body: people('Jonas Keller, CTO. Email: jonas.keller@vectorly.example', 'Mira Hoffmann, Head of Growth.'),
      },
      {
        path: 'careers/monetization-engineer',
        kind: 'job',
        title: 'Monetization Engineer',
        daysAgo: 14,
        // The role gets filled and the posting comes down. The Skeptic should catch this.
        afterCrawl: { action: 'gone' },
        body: p(
          'Vectorly is hiring a Monetization Engineer to build usage-based billing for our cloud product.',
          'This is the first dedicated billing role on the team.',
        ),
      },
      {
        path: 'news/seed-extension',
        kind: 'news',
        title: 'Vectorly extends its seed round',
        daysAgo: 50,
        body: p(
          'Vectorly raises $8 million seed extension to scale its managed cloud.',
          'Existing investors took the full round.',
        ),
      },
    ],
  },
  {
    slug: 'cobalt-ledger',
    name: 'Cobalt Ledger',
    domain: 'cobaltledger.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Cobalt Ledger',
        body: p(
          'Cobalt Ledger provides a payments reconciliation platform for marketplaces and fintech lenders.',
          'The company has 320 employees and is headquartered in New York, New York.',
        ),
      },
      {
        path: 'team',
        kind: 'team',
        title: 'Leadership',
        // No email addresses are published, so the contact can only be guessed.
        body: people('Ibrahim Noor, VP Engineering.', 'Dana Whitfield, Chief Revenue Officer.'),
      },
      {
        path: 'news/new-cro',
        kind: 'news',
        title: 'Cobalt Ledger names a Chief Revenue Officer',
        daysAgo: 30,
        body: p(
          'Cobalt Ledger appoints Dana Whitfield as Chief Revenue Officer to lead its move upmarket.',
          'She joins from a payments infrastructure company.',
        ),
      },
    ],
  },
  {
    slug: 'tessera-health',
    name: 'Tessera Health',
    domain: 'tesserahealth.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Tessera Health',
        body: p(
          'Tessera Health runs a patient scheduling platform for hospital networks.',
          'Tessera Health has 900 employees and is headquartered in Boston, Massachusetts.',
        ),
      },
      // No team page: the contact cannot be resolved and the grid should say so.
      {
        path: 'careers/billing-systems-analyst',
        kind: 'job',
        title: 'Billing Systems Analyst',
        daysAgo: 25,
        body: p(
          'Tessera Health is hiring a Billing Systems Analyst to support its usage-based contracts with hospital partners.',
          'The role sits in the finance operations group.',
        ),
      },
    ],
  },
  {
    slug: 'brightloop',
    name: 'Brightloop',
    domain: 'brightloop.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Brightloop',
        body: p(
          'Brightloop is a SaaS platform for customer onboarding workflows.',
          'We are a team of 210 people headquartered in Amsterdam, Netherlands.',
        ),
      },
      {
        path: 'team',
        kind: 'team',
        title: 'Team',
        body: people('Annelies de Vries, VP Engineering. Email: annelies.devries@brightloop.example', 'Pieter Maas, Head of Finance.'),
      },
      {
        path: 'news/series-a',
        kind: 'news',
        title: 'Brightloop raises its Series A',
        // Fourteen months old: a real fact, and not a why-now.
        daysAgo: 425,
        body: p('Brightloop raises $18 million Series A led by Polder Capital.', 'The company plans to double its engineering team.'),
      },
      {
        path: 'careers/billing-platform-lead',
        kind: 'job',
        title: 'Billing Platform Lead',
        batch: 1,
        daysAgo: 1,
        body: p(
          'Brightloop is hiring a Billing Platform Lead to move the product from seat pricing to metered plans.',
          'You will pick the billing stack and run the migration.',
        ),
      },
    ],
  },
  {
    slug: 'parallax-data',
    name: 'Parallax Data',
    domain: 'parallaxdata.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Parallax Data',
        body: p(
          'Parallax Data builds AI evaluation tooling for machine learning teams.',
          'Our 45-person team is headquartered in Seattle, Washington.',
        ),
      },
      {
        path: 'team',
        kind: 'team',
        title: 'Team',
        body: people('Grace Liu, Head of Platform. Email: grace.liu@parallaxdata.example'),
      },
      {
        path: 'news/vp-finance',
        kind: 'news',
        title: 'Parallax Data adds a finance lead',
        batch: 2,
        daysAgo: 1,
        body: p(
          'Parallax Data appoints Rahul Mehta as VP of Finance ahead of its enterprise launch.',
          'He will set up pricing and billing operations.',
        ),
      },
    ],
  },
  {
    slug: 'kestrel-systems',
    name: 'Kestrel Systems',
    domain: 'kestrelsystems.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Kestrel Systems',
        body: p(
          'Kestrel Systems makes observability and developer tools for platform teams.',
          'Kestrel Systems has 500 employees and is headquartered in Denver, Colorado.',
        ),
      },
      {
        path: 'team',
        kind: 'team',
        title: 'Leadership',
        body: people('Owen Hartley, VP Engineering. Email: owen.hartley@kestrelsystems.example'),
      },
      {
        path: 'careers/staff-engineer-billing',
        kind: 'job',
        title: 'Staff Engineer, Billing',
        daysAgo: 12,
        body: p('Kestrel Systems is hiring a Staff Engineer for Billing to rebuild its usage metering.', 'The posting has been open since the reorganisation.'),
      },
      {
        path: 'news/restructuring',
        kind: 'news',
        title: 'An update on our organisation',
        daysAgo: 40,
        body: p(
          'Kestrel Systems is reducing its workforce by 18% as part of a company-wide restructuring.',
          'Affected employees will receive severance and extended benefits.',
        ),
      },
    ],
  },
  {
    slug: 'mosaic-commerce',
    name: 'Mosaic Commerce',
    domain: 'mosaiccommerce.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Mosaic Commerce',
        body: p(
          'Mosaic Commerce powers checkout and storefronts for online retail and e-commerce brands.',
          'We are a team of 260 people headquartered in London, United Kingdom.',
        ),
      },
      {
        path: 'team',
        kind: 'team',
        title: 'Team',
        body: people('Hugo Laurent, CTO. Email: hugo.laurent@mosaiccommerce.example'),
      },
      {
        path: 'news/series-b',
        kind: 'news',
        title: 'Mosaic Commerce closes Series B',
        daysAgo: 80,
        body: p('Mosaic Commerce raises $25 million Series B to expand across Europe.', 'The company will open offices in Paris and Madrid.'),
      },
      {
        path: 'news/billing-partner',
        kind: 'news',
        title: 'Mosaic Commerce picks a billing partner',
        daysAgo: 60,
        body: p(
          'Mosaic Commerce signs a three-year agreement with Chargeline for subscription and usage billing.',
          'The rollout finishes this quarter.',
        ),
      },
    ],
  },
  {
    slug: 'orbitcast',
    name: 'Orbitcast',
    domain: 'orbitcast.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Orbitcast',
        body: p(
          'Orbitcast is a streaming media platform for independent podcast and video publishers.',
          'Orbitcast has 150 employees and is headquartered in Los Angeles, California.',
        ),
      },
      {
        path: 'news/metered-hosting',
        kind: 'news',
        title: 'Hosting plans are changing',
        daysAgo: 45,
        body: p('Orbitcast is switching to metered pricing for its hosting plans.', 'Publishers will pay for hours streamed.'),
      },
      {
        path: 'news/hiring-update',
        kind: 'news',
        title: 'A note on hiring',
        daysAgo: 30,
        body: p(
          'Orbitcast has paused all hiring through the end of the fiscal year, according to an internal memo.',
          'Open roles have been closed.',
        ),
      },
    ],
  },
  {
    slug: 'sundial-labs',
    name: 'Sundial Labs',
    domain: 'sundiallabs.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Sundial Labs',
        body: p('Sundial Labs builds AI forecasting models for energy traders.', 'Our 70-person team is headquartered in Singapore.'),
      },
      {
        path: 'team',
        kind: 'team',
        title: 'Team',
        body: people('Wei Jie Tan, CTO. Email: weijie.tan@sundiallabs.example'),
      },
      {
        path: 'careers/billing-engineer',
        kind: 'job',
        title: 'Billing Engineer',
        daysAgo: 10,
        body: p('Sundial Labs is hiring a Billing Engineer to launch usage-based plans for its API.', 'The role is based in Singapore.'),
      },
    ],
  },
  {
    slug: 'fathom-works',
    name: 'Fathom Works',
    domain: 'fathomworks.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Fathom Works',
        body: p(
          'Fathom Works is a SaaS analytics suite for subscription businesses.',
          'Fathom Works has 120 employees and is headquartered in Toronto, Canada.',
        ),
      },
      {
        path: 'team',
        kind: 'team',
        title: 'Team',
        body: people('Leah Goldberg, Head of Platform. Email: leah.goldberg@fathomworks.example'),
      },
      {
        path: 'news/pricing-update',
        kind: 'news',
        title: 'Pricing update',
        daysAgo: 15,
        // The announcement is walked back. The page still loads, but the sentence is gone.
        afterCrawl: {
          action: 'edit',
          body: p('Fathom Works has postponed its planned pricing changes until further notice.', 'Current plans stay as they are.'),
        },
        body: p(
          'Fathom Works is introducing usage-based pricing tiers for its analytics API next month.',
          'Existing customers keep their current plan for one year.',
        ),
      },
    ],
  },
  // ----- competitors -----
  {
    slug: 'chargeline',
    name: 'Chargeline',
    domain: 'chargeline.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Chargeline',
        body: p(
          'Chargeline is a usage-based billing platform for SaaS companies.',
          'Chargeline has 400 employees and is headquartered in San Francisco, California.',
        ),
      },
      {
        path: 'pricing',
        kind: 'pricing',
        title: 'Pricing',
        body: p(
          'The Starter plan costs $799 per month, billed annually.',
          'The Scale plan costs $2,500 per month and includes revenue recognition.',
        ),
      },
    ],
  },
  {
    slug: 'tallybird',
    name: 'Tallybird',
    domain: 'tallybird.example',
    pages: [
      {
        path: 'about',
        kind: 'about',
        title: 'About Tallybird',
        body: p(
          'Tallybird is a metering and usage-based billing API for developer platforms.',
          'Our 90-person team is headquartered in Dublin, Ireland.',
        ),
      },
      {
        path: 'pricing',
        kind: 'pricing',
        title: 'Pricing',
        body: p('Tallybird charges 1.2% of invoiced revenue with a $1,000 monthly minimum.', 'Volume discounts start at $5 million in annual billings.'),
      },
    ],
  },
];

/** The example intake that matches the seeded world. */
export const EXAMPLE_PROFILE = {
  product_name: 'Tollgate',
  description:
    'Tollgate is usage-based billing and metering infrastructure for AI, API and SaaS companies. A drop-in SDK meters every API call, enforces credit limits in real time and generates invoices, so engineering teams stop building billing in-house.',
  customers: ['Lumen Cloud', 'Parsec AI', 'Driftwood Analytics'],
  pricing: '$499 per month platform fee plus 0.5% of billed revenue. Enterprise plans from $40,000 per year.',
  excluded_regions: ['APAC'],
  sender: 'Zafar',
};
