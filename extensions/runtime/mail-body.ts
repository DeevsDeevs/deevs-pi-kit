/** Images travel inside a mail body as `<image>/abs/path</image>` lines: protocol framing, read as syntax only. */
const IMAGE_TAG = /<image>([^<\n]+)<\/image>\n?/g;

export function encodeMail(message: string, images: readonly string[] = []): string {
	return [message.replaceAll("<image>", "<\\image>"), ...images.map((path) => `<image>${path}</image>`)].join("\n");
}

export interface MailBody {
	text: string;
	images: string[];
}

export function decodeMail(body: string): MailBody {
	return { text: body.replace(IMAGE_TAG, "").trimEnd(), images: [...body.matchAll(IMAGE_TAG)].map((match) => match[1]) };
}
