import assert from "node:assert/strict";
import { test } from "node:test";
import { OriginPolicy } from "./OriginPolicy.ts";

test("resolves canonical Penpot asset URLs inside Docker without changing unrelated URLs", () => {
    const policy = new OriginPolicy("http://penpot-frontend:8080");
    const script = policy.rewriteConfiguration('var penpotPublicURI = "http://192.168.21.230:9001";');
    assert.ok(script.endsWith('var penpotPublicURI = "http://penpot-frontend:8080";\n'));
    assert.equal(
        policy.assetUrl("http://192.168.21.230:9001/assets/by-id/font?format=woff"),
        "http://penpot-frontend:8080/assets/by-id/font?format=woff"
    );
    assert.equal(policy.assetUrl("https://third-party.example/assets/photo.png"), null);
    assert.equal(policy.assetUrl("http://192.168.21.230:9001/api/private"), null);
    assert.equal(policy.assetUrl("http://secret:password@192.168.21.230:9001/assets/by-id/font"), null);
});
