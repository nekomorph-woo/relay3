export interface ChatIdentity {
  privateKey: string;
  publicKey: string;
}
export interface ChatRecipient {
  id: string;
  publicKey: string;
}
export interface Envelope {
  version: 1;
  clientId: string;
  ephemeral: string;
  salt: string;
  nonce: string;
  body: string;
  recipients: { id: string; publicKey: string; nonce: string; key: string }[];
}
export interface ChatMessage {
  id: number;
  clientId: string;
  senderId: string;
  senderName: string;
  createdAt: number;
  mode: 'plain' | 'encrypted';
  content: string | null;
  envelope: Envelope | null;
  remark: string;
  remarkStyle: 'hint' | 'note' | 'clue';
}
export interface ChatDevice {
  id: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeen: number;
  publicKey: string | null;
}
export interface ChatContext {
  stationId: string;
  senderId: string;
  remark: string;
  remarkStyle: string;
}
export interface ChatFilter {
  before?: number;
  senderId?: string;
  mode?: string;
  ids?: number[];
}
