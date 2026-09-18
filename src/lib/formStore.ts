export interface FormData {
  petType: 'dog' | 'cat' | 'both' | null;
  // dog
  dogName: string;
  dogBreed: string;
  dogAge: string;
  dogWeightKg: string;
  dogSize: string;
  // cat (kept for DB compatibility)
  catName: string;
  catBreed: string;
  catAge: string;
  catWeightKg: string;
  catLifestyle: string;
  // diet
  currentFoodType: string;
  currentFoodBrand: string;
  hasSensitivities: boolean;
  sensitivitiesDescription: string;
  referralSource: string;
  // personal
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  street: string;
  postalCode: string;
  city: string;
  country: string;
  // consents
  gdprConsent: boolean;
  verificationConsent: boolean;
  newsletterConsent: boolean;
  // honeypot
  website: string;
}

export const defaultFormData: FormData = {
  petType: null,
  dogName: '',
  dogBreed: '',
  dogAge: '',
  dogWeightKg: '',
  dogSize: '',
  catName: '',
  catBreed: '',
  catAge: '',
  catWeightKg: '',
  catLifestyle: '',
  currentFoodType: '',
  currentFoodBrand: '',
  hasSensitivities: false,
  sensitivitiesDescription: '',
  referralSource: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  street: '',
  postalCode: '',
  city: '',
  country: 'Polska',
  gdprConsent: false,
  verificationConsent: false,
  newsletterConsent: false,
  website: '',
};

let storedData: FormData = { ...defaultFormData };

export const setFormData = (data: FormData) => {
  storedData = { ...data };
};

export const getFormData = (): FormData => storedData;

export const getPetName = (data: FormData): string => {
  return data.dogName || 'Twojego pupila';
};
