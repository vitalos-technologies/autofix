/**
 * Places API (New) responses for the mock provider and the mapping tests, in the exact JSON shape
 * `places:searchText` and `places/{id}` return for our field masks. The garages are fictional;
 * phone numbers are in Ofcom's drama range (01632 960xxx) and websites use `.example`.
 */
import type { RawPlace } from "./types";

export const PLACE_FIXTURES: RawPlace[] = [
  {
    id: "ChIJmockKingswayAutocare01",
    displayName: { text: "Kingsway Autocare", languageCode: "en" },
    formattedAddress: "Unit 4, Kingsway Trade Park, 12 Kingsway, Doncaster DN4 5AB, UK",
    addressComponents: [
      { longText: "Unit 4", shortText: "Unit 4", types: ["subpremise"] },
      { longText: "Kingsway Trade Park", shortText: "Kingsway Trade Park", types: ["premise"] },
      { longText: "12", shortText: "12", types: ["street_number"] },
      { longText: "Kingsway", shortText: "Kingsway", types: ["route"] },
      { longText: "Balby", shortText: "Balby", types: ["sublocality_level_1", "sublocality", "political"] },
      { longText: "Doncaster", shortText: "Doncaster", types: ["postal_town"] },
      { longText: "South Yorkshire", shortText: "South Yorkshire", types: ["administrative_area_level_2", "political"] },
      { longText: "England", shortText: "England", types: ["administrative_area_level_1", "political"] },
      { longText: "United Kingdom", shortText: "GB", types: ["country", "political"] },
      { longText: "DN4 5AB", shortText: "DN4 5AB", types: ["postal_code"] },
    ],
    nationalPhoneNumber: "01632 960123",
    internationalPhoneNumber: "+44 1632 960123",
    websiteUri: "https://kingsway-autocare.example/?utm_source=google&utm_medium=organic",
    businessStatus: "OPERATIONAL",
    regularOpeningHours: {
      periods: [
        { open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 17, minute: 30 } },
        { open: { day: 2, hour: 8, minute: 0 }, close: { day: 2, hour: 17, minute: 30 } },
        { open: { day: 3, hour: 8, minute: 0 }, close: { day: 3, hour: 17, minute: 30 } },
        { open: { day: 4, hour: 8, minute: 0 }, close: { day: 4, hour: 17, minute: 30 } },
        { open: { day: 5, hour: 8, minute: 0 }, close: { day: 5, hour: 17, minute: 0 } },
        { open: { day: 6, hour: 9, minute: 0 }, close: { day: 6, hour: 12, minute: 30 } },
      ],
    },
  },
  {
    id: "ChIJmockStationRoadGarage2",
    displayName: { text: "Station Road Garage", languageCode: "en" },
    formattedAddress: "48 Station Rd, Rotherham S60 1AA, UK",
    addressComponents: [
      { longText: "48", shortText: "48", types: ["street_number"] },
      { longText: "Station Road", shortText: "Station Rd", types: ["route"] },
      { longText: "Rotherham", shortText: "Rotherham", types: ["postal_town"] },
      { longText: "United Kingdom", shortText: "GB", types: ["country", "political"] },
      { longText: "S60 1AA", shortText: "S60 1AA", types: ["postal_code"] },
    ],
    nationalPhoneNumber: "01632 960456",
    internationalPhoneNumber: "+44 1632 960456",
    businessStatus: "OPERATIONAL",
    regularOpeningHours: {
      periods: [
        // Split day on Monday, a lunch break.
        { open: { day: 1, hour: 8, minute: 30 }, close: { day: 1, hour: 12, minute: 30 } },
        { open: { day: 1, hour: 13, minute: 30 }, close: { day: 1, hour: 17, minute: 30 } },
        { open: { day: 2, hour: 8, minute: 30 }, close: { day: 2, hour: 17, minute: 30 } },
        { open: { day: 3, hour: 8, minute: 30 }, close: { day: 3, hour: 17, minute: 30 } },
        { open: { day: 4, hour: 8, minute: 30 }, close: { day: 4, hour: 17, minute: 30 } },
        { open: { day: 5, hour: 8, minute: 30 }, close: { day: 5, hour: 17, minute: 30 } },
        // Overnight period (left out by the mapping).
        { open: { day: 6, hour: 22, minute: 0 }, close: { day: 0, hour: 2, minute: 0 } },
      ],
    },
  },
  {
    // A sparse listing: no phone, website or hours (the owner fills them in).
    id: "ChIJmockMillfieldMotors03",
    displayName: { text: "Millfield Motors", languageCode: "en" },
    formattedAddress: "Millfield Lane, Thorne, Doncaster DN8 4ZZ, UK",
    addressComponents: [
      { longText: "Millfield Lane", shortText: "Millfield Ln", types: ["route"] },
      { longText: "Thorne", shortText: "Thorne", types: ["locality", "political"] },
      { longText: "Doncaster", shortText: "Doncaster", types: ["postal_town"] },
      { longText: "United Kingdom", shortText: "GB", types: ["country", "political"] },
      { longText: "DN8 4ZZ", shortText: "DN8 4ZZ", types: ["postal_code"] },
    ],
    businessStatus: "OPERATIONAL",
  },
];
