// Reference server entry — one route, mounted at /api/ext/<extensionId>/hello
// while this extension is installed and enabled.
export function activate({ router, log }) {
  router.get("/hello", (req, res) => {
    log("GET /hello");
    res.json({ message: "Hello from the sample extension's server hook!" });
  });
}
