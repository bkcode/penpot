import assert from "node:assert/strict";
import { test } from "node:test";
import { ArchiveDownload } from "./ArchiveDownload.ts";

for (const value of [
    "http://example.com/file.penpot",
    "https://user:secret@example.com/a",
    "https://example.com:8443/a",
    "file:///etc/passwd",
    "https://example.com/a#private",
]) {
    test(`rejects unsupported archive URL ${new URL(value).protocol}`, () => {
        assert.throws(() => ArchiveDownload.validateUrl(value));
    });
}
for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "198.18.0.13",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a9fe:a9fe",
]) {
    test(`blocks non-public archive target ${address}`, async () => {
        const downloader = new ArchiveDownload({
            resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        });
        await assert.rejects(downloader.publicAddresses(new URL("https://example.com/a.penpot")), /ssrf_blocked/);
    });
}
test("rejects mixed public/private DNS answers and accepts public answers", async () => {
    const blocked = new ArchiveDownload({
        resolve: async () => [
            { address: "1.1.1.1", family: 4 },
            { address: "127.0.0.1", family: 4 },
        ],
    });
    await assert.rejects(blocked.publicAddresses(new URL("https://example.com/a.penpot")), /ssrf_blocked/);
    const allowed = new ArchiveDownload({ resolve: async () => [{ address: "1.1.1.1", family: 4 }] });
    assert.deepEqual(await allowed.publicAddresses(new URL("https://example.com/a.penpot")), [
        { address: "1.1.1.1", family: 4 },
    ]);
});
