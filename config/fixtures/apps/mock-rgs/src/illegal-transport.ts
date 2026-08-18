// FIXTURE — must be rejected by `mock-rgs-deps`: the server does not get to implement the client's
// transport. That would invert the seam this app exists to prove.
import { HttpTransport } from '@slot/transport';

export const leak = HttpTransport;
