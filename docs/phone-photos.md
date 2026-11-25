# Photos from the phone

The Squall app can send photos into any chat, the same as pasting them into the chat here.

Action: `chat.sendPhoto { chatId, text?, photos: [{ data, type, name? }] }`

- `data` is base64 with no `data:` prefix. `type` is `image/jpeg` or `image/png`.
- 1 to 3 photos, each up to 700 KB. The link takes 1 MB a request, so the phone shrinks photos before sending.
- Each photo is saved with `saveImage` (the same as a pasted one), then the message goes in as Storm's with the photos
  attached, so the teammate gets the saved paths to open with Read.
- The answer is `{ ok: true }`, or `{ ok: false, error }` when the chat is busy, Squall isn't signed in, or a photo
  couldn't be saved.

On the phone's state, a message with photos has `photos` (how many). One with no words shows as "📷 Photo" or
"📷 2 photos", so it still reads well on older apps.

Code: `SquallPhotos` in web/link.js (checks and steps, tested in tests/web/photos.test.mjs) and `SquallPhotoOps` in
web/app.js (saving and sending in the window).
