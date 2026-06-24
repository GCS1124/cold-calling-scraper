export const companyTypeOptions = [
  'Dental Clinics',
  'HVAC Contractors',
  'Real Estate Agencies',
  'Plumbers',
  'Roofing Contractors',
  'Medical Clinics',
  'SaaS Agencies',
  'Law Firms',
  'Auto Repair',
  'Marketing Agencies',
  'Ecommerce Brands',
];

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
