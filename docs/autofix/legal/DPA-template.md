# Data Processing Agreement (v1.1)

Between **[Garage legal name]** ("the Garage", controller) and **Vitalos Technologies Ltd** ("Vitalos", processor), for the Autofix service. Accepted on [date] by [name, role].

## 1. Scope

1.1 Vitalos processes personal data on the Garage's behalf to provide Autofix: online booking, diary, customer and vehicle records, reminders, messaging, missed-call handling, invoicing and related support.

1.2 This agreement follows Article 28 of the UK GDPR and the Data Protection Act 2018. It runs for as long as the Garage uses Autofix, plus the deletion period in clause 10.

## 2. Processing details

| Item | Detail |
| --- | --- |
| Data subjects | The Garage's customers and enquirers; the Garage's staff users |
| Personal data | Names, mobile numbers, email addresses, postal addresses and postcodes (mobile visits), vehicle registrations and vehicle details, MOT and mileage history, booking details and notes, messages and call records (number, time, voicemail), invoices, consent records, staff account details |
| Special category data | None intended. The Garage should not enter health or other special category data in notes |
| Purpose | Providing Autofix to the Garage as described in clause 1.1 |
| Processing operations | Collection, storage, retrieval, organisation, transmission (SMS, WhatsApp, email), vehicle lookups, deletion |
| Location | Primary database in London (UK). Some sub-processors operate outside the UK (clause 7) |

## 3. Instructions

3.1 Vitalos processes the personal data only on the Garage's documented instructions. This agreement, the Garage's settings in Autofix and actions taken by its users are those instructions.

3.2 Vitalos will tell the Garage if it believes an instruction breaks data protection law.

## 4. Confidentiality

Vitalos makes sure that anyone authorised to process the data is bound by confidentiality.

## 5. Security

Vitalos keeps appropriate technical and organisational measures in place (Annex A), including tenant isolation, encryption in transit and at rest, access controls with multi-factor authentication, logging and backups.

## 6. The Garage's responsibilities

6.1 The Garage is responsible for having a lawful basis for its processing, including consent or the "soft opt-in" for reminder messages, and for the accuracy of data it imports.

6.2 The Garage will not import customer lists for messaging unless it holds the consent or soft opt-in needed.

## 7. Sub-processors

7.1 The Garage gives general authorisation for Vitalos to use sub-processors to provide Autofix. Vitalos keeps a current list of them and gives it to the Garage on request. Vitalos will give at least 30 days' notice of a new or replacement sub-processor, and the Garage may object on reasonable grounds.

7.2 Vitalos puts equivalent data protection terms in place with each sub-processor and stays responsible for them.

7.3 Where data leaves the UK, Vitalos relies on UK adequacy regulations or the International Data Transfer Agreement or Addendum.

## 8. Assistance

8.1 Vitalos helps the Garage respond to data subject requests (access, correction, deletion, objection) through features in Autofix and, where needed, by support.

8.2 Vitalos helps the Garage with security, breach notification and data protection impact assessments, taking into account the information available to Vitalos.

## 9. Personal data breaches

Vitalos notifies the Garage without undue delay, and within 48 hours of becoming aware, of a personal data breach affecting the Garage's data. The notice includes what is known about the nature, likely consequences and measures taken.

## 10. End of the service

On termination Vitalos makes an export available for 30 days, then deletes the Garage's personal data, unless the law requires it to be kept. Backups roll off within a further 35 days.

## 11. Audits

Vitalos provides the information needed to show compliance with this agreement and allows audits by the Garage or its appointed auditor, on reasonable notice, no more than once a year unless a breach has occurred.

## Annex A: Security measures

- Row-level security isolates each garage's data; automated tests check isolation on every change.
- TLS for all traffic; encryption at rest by the database provider.
- Staff accounts with multi-factor authentication; owner accounts must use it.
- Secrets held in the hosting provider's secret store, never in code.
- Registrations kept out of URLs and analytics; booking-management tokens stored as hashes.
- Daily backups; error monitoring; access logs; least-privilege access for Vitalos staff, with impersonation logged.
- Retention: cancelled and no-show bookings anonymised after 24 months; message bodies after 12 months.
