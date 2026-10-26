// Messaging library barrel. Server-only (channel.ts, twilio.ts and email.ts
// import "server-only"). Client components, such as the template editor's SMS
// counter, import the pure modules directly:
//   @/lib/messaging/templates, @/lib/messaging/quiet-hours,
//   @/lib/messaging/keywords, @/lib/messaging/phone

export {
  createUnconfiguredChannel,
  getChannel,
  type ChannelKind,
  type DeliveryStatus,
  type MessageChannel,
  type OutboundMessage,
  type SendFailure,
  type SendFailureCode,
  type SendResult,
  type SendSuccess,
  type WhatsAppTemplate,
} from "./channel";
export {
  getMessagingMode,
  getMessagingReadiness,
  readTwilioConfig,
  TWILIO_STATUS_CALLBACK_PATH,
  type ChannelReadiness,
  type MessagingEnv,
  type MessagingMode,
  type MessagingReadiness,
} from "./config";
export { createResendEmailChannel, resendIdempotencyKey, type ResendEmailChannelOptions } from "./email";
export { classifyInbound, HELP_KEYWORDS, OPT_IN_KEYWORDS, OPT_OUT_KEYWORDS, type InboundIntent } from "./keywords";
export { clearMockOutbox, createMockChannel, getMockOutbox, type MockOutboxEntry } from "./mock";
export { isE164, isUkMobileE164, maskPhone, toE164UK } from "./phone";
export { DEFAULT_TIME_ZONE, isWithinSendWindow, nextSendWindow, SEND_WINDOW_END_HOUR, SEND_WINDOW_START_HOUR } from "./quiet-hours";
export { configurationRequired, isValidAlphanumericSenderId, MAX_BODY_LENGTH } from "./results";
export {
  BOOKING_PLACEHOLDERS,
  DEFAULT_TEMPLATES,
  hasOptOut,
  OPT_OUT_LINE,
  REMINDER_PLACEHOLDERS,
  renderTemplate,
  smsSegments,
  TEMPLATE_PLACEHOLDERS,
  withOptOut,
  type DefaultTemplate,
  type RenderedTemplate,
  type SmsEncoding,
  type SmsSegmentInfo,
  type TemplateKind,
  type TemplatePlaceholder,
  type TemplateVariables,
} from "./templates";
export {
  computeTwilioSignature,
  createTwilioSmsChannel,
  createTwilioWhatsAppChannel,
  isLaterStatus,
  mapTwilioError,
  mapTwilioStatus,
  parseTwilioForm,
  parseTwilioInboundMessage,
  parseTwilioStatusCallback,
  TWILIO_ERROR_WHATSAPP_OUTSIDE_WINDOW,
  verifyTwilioSignature,
  type TwilioInboundMessage,
  type TwilioParams,
  type TwilioSmsChannelOptions,
  type TwilioStatusCallback,
  type TwilioWhatsAppChannelOptions,
  type VerifyTwilioSignatureInput,
} from "./twilio";
