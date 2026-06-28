export type CompanyTypeSuggestion = {
  value: string;
  keywords: string[];
};

export const companyTypeSuggestions: CompanyTypeSuggestion[] = [
  {
    value: 'Dentist',
    keywords: [
      'Dental Clinics',
      'Dental Office',
      'Orthodontist',
      'Periodontist',
      'Oral Surgeon',
      'Cosmetic Dentist',
    ],
  },
  {
    value: 'HVAC contractor',
    keywords: [
      'HVAC Contractors',
      'Air Conditioning Repair',
      'AC Repair',
      'Heating Contractor',
      'Furnace Repair',
      'Heating and Cooling',
    ],
  },
  {
    value: 'Plumber',
    keywords: [
      'Plumbers',
      'Plumbing Company',
      'Plumbing Service',
      'Emergency Plumber',
      'Drain Cleaning',
      'Water Heater Repair',
    ],
  },
  {
    value: 'Roofer',
    keywords: [
      'Roofing Contractors',
      'Roofing Company',
      'Roof Repair',
      'Roof Replacement',
      'Roof Inspection',
    ],
  },
  {
    value: 'Real estate agent',
    keywords: [
      'Real Estate Agencies',
      'Realtor',
      'Broker',
      'Property Management',
      'Real Estate Office',
    ],
  },
  {
    value: 'Attorney',
    keywords: ['Law Firms', 'Lawyer', 'Law Office', 'Legal Services', 'Personal Injury Lawyer'],
  },
  {
    value: 'Urgent care',
    keywords: ['Medical Clinics', 'Health Clinic', 'Doctor Office', 'Walk-In Clinic', 'Family Medicine'],
  },
  {
    value: 'Mechanic',
    keywords: ['Auto Repair', 'Auto Repair Shop', 'Car Repair', 'Auto Service', 'Brake Shop', 'Tire Shop'],
  },
  {
    value: 'SEO agency',
    keywords: [
      'Marketing Agencies',
      'Digital Marketing',
      'Advertising Agency',
      'Social Media Marketing',
      'Lead Generation Agency',
    ],
  },
  {
    value: 'Commercial cleaning',
    keywords: ['Cleaning Services', 'Cleaning Company', 'Janitorial Services', 'House Cleaning', 'Maid Service'],
  },
  {
    value: 'Software company',
    keywords: ['SaaS Agencies', 'Tech Company', 'IT Services', 'Software Development', 'Web Development'],
  },
  {
    value: 'Ecommerce brand',
    keywords: ['Ecommerce Brands', 'Online Store', 'Shopify Store', 'Direct-to-Consumer Brand'],
  },
];

const uniqueStrings = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

export const companyTypeOptions = uniqueStrings(
  companyTypeSuggestions.flatMap((suggestion) => [suggestion.value, ...suggestion.keywords]),
);

export const timeZoneOptions = [
  { code: 'EST', label: 'Eastern Time' },
  { code: 'CST', label: 'Central Time' },
  { code: 'MST', label: 'Mountain Time' },
  { code: 'PST', label: 'Pacific Time' },
] as const;

export type TimeZoneCode = (typeof timeZoneOptions)[number]['code'];

export const timeZoneCodes = timeZoneOptions.map((option) => option.code) as readonly TimeZoneCode[];

export const timeZoneLabelsByCode = Object.fromEntries(
  timeZoneOptions.map((option) => [option.code, option.label]),
) as Record<TimeZoneCode, string>;
