#!/usr/bin/env node

// Native
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { promisify } = require("util");
const { parse } = require("url");
const os = require("os");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");

// Packages
const Ajv = require("ajv");
const checkForUpdate = require("update-check");
const chalk = require("chalk");
const arg = require("arg");
const { write: copy } = require("clipboardy");
const handler = require("serve-handler");
const schema = require("@zeit/schemas/deployment/config-static");
const boxen = require("boxen");
const compression = require("compression");

// Utilities
const pkg = require("../package");

const readFile = promisify(fs.readFile);
const compressionHandler = promisify(compression());

const interfaces = os.networkInterfaces();

const warning = message => chalk`{yellow WARNING:} ${message}`;
const info = message => chalk`{magenta INFO:} ${message}`;
const error = message => chalk`{red ERROR:} ${message}`;

const updateCheck = async isDebugging => {
  let update = null;

  try {
    update = await checkForUpdate(pkg);
  } catch (err) {
    const suffix = isDebugging ? ":" : " (use `--debug` to see full error)";
    console.error(warning(`Checking for updates failed${suffix}`));

    if (isDebugging) {
      console.error(err);
    }
  }

  if (!update) {
    return;
  }

  console.log(
    `${chalk.bgRed("UPDATE AVAILABLE")} The latest version of \`serve\` is ${
      update.latest
    }`
  );
};

const getHelp = () => chalk`
  {bold.cyan qr-serve} - Static file serving and QR Code listing

  {bold USAGE}

      {bold $} {cyan qr-serve} --help
      {bold $} {cyan qr-serve} --version
      {bold $} {cyan qr-serve} folder_name
      {bold $} {cyan qr-serve} [-l {underline listen_uri} [-l ...]] [{underline directory}]

      By default, {cyan qr-serve} will listen on {bold 0.0.0.0:8080} and serve the
      current working directory on that address.

      Specifying a single {bold --listen} argument will overwrite the default, not supplement it.

  {bold OPTIONS}

      --help                              Shows this help message

      -v, --version                       Displays the current version of serve

      -l, --listen {underline listen_uri}             Specify a URI endpoint on which to listen (see below) -
                                          more than one may be specified to listen in multiple places

      -d, --debug                         Show debugging information

      -s, --single                        Rewrite all not-found requests to \`index.html\`

      -c, --config                        Specify custom path to \`serve.json\`

      -n, --no-clipboard                  Do not copy the local address to the clipboard

      -u, --no-compression                Do not compress files

      --no-etag                           Send \`Last-Modified\` header instead of \`ETag\`

      -S, --symlinks                      Resolve symlinks instead of showing 404 errors

      --ssl-cert                          Optional path to an SSL/TLS certificate to serve with HTTPS

      --ssl-key                           Optional path to the SSL/TLS certificate\'s private key

  {bold ENDPOINTS}

      Listen endpoints (specified by the {bold --listen} or {bold -l} options above) instruct {cyan serve}
      to listen on one or more interfaces/ports, UNIX domain sockets, or Windows named pipes.

      For TCP ports on hostname "localhost":

          {bold $} {cyan qr-serve} -l {underline 1234}

      For TCP (traditional host/port) endpoints:

          {bold $} {cyan qr-serve} -l tcp://{underline hostname}:{underline 1234}

      For UNIX domain socket endpoints:

          {bold $} {cyan qr-serve} -l unix:{underline /path/to/socket.sock}

      For Windows named pipe endpoints:

          {bold $} {cyan qr-serve} -l pipe:\\\\.\\pipe\\{underline PipeName}
`;

const parseEndpoint = str => {
  if (!isNaN(str)) {
    return [str];
  }

  // We cannot use `new URL` here, otherwise it will not
  // parse the host properly and it would drop support for IPv6.
  const url = parse(str);

  switch (url.protocol) {
    case "pipe:": {
      // some special handling
      const cutStr = str.replace(/^pipe:/, "");

      if (cutStr.slice(0, 4) !== "\\\\.\\") {
        throw new Error(`Invalid Windows named pipe endpoint: ${str}`);
      }

      return [cutStr];
    }
    case "unix:":
      if (!url.pathname) {
        throw new Error(`Invalid UNIX domain socket endpoint: ${str}`);
      }

      return [url.pathname];
    case "tcp:":
      url.port = url.port || "8080";
      return [parseInt(url.port, 10), url.hostname];
    default:
      throw new Error(
        `Unknown --listen endpoint scheme (protocol): ${url.protocol}`
      );
  }
};

const registerShutdown = fn => {
  let run = false;

  const wrapper = () => {
    if (!run) {
      run = true;
      fn();
    }
  };

  process.on("SIGINT", wrapper);
  process.on("SIGTERM", wrapper);
  process.on("exit", wrapper);
};

const getNetworkAddress = () => {
  for (const name of Object.keys(interfaces)) {
    for (const interface of interfaces[name]) {
      const { address, family, internal } = interface;
      if (family === "IPv4" && !internal) {
        return address;
      }
    }
  }
};

const getColor = (color, str) => {
  if (color === "blue") {
    return chalk.blue(str);
  } else if (color === "black") {
    return chalk.black(str);
  } else if (color === "red") {
    return chalk.red(str);
  } else if (color === "green") {
    return chalk.green(str);
  } else if (color === "yellow") {
    return chalk.yellow(str);
  } else if (color === "magenta") {
    return chalk.magenta(str);
  } else if (color === "cyan") {
    return chalk.cyan(str);
  } else if (color === "white") {
    return "\n" + chalk.whiteBright.bgBlack(str);
  } else {
    return chalk.black(str);
  }
};
const startEndpoint = (endpoint, config, args, previous) => {
  const { isTTY } = process.stdout;
  const clipboard = args["--no-clipboard"] !== true;
  const compress = args["--no-compression"] !== true;
  const httpMode = args["--ssl-cert"] && args["--ssl-key"] ? "https" : "http";

  const serverHandler = async (request, response) => {
    if (compress) {
      await compressionHandler(request, response);
    }

    return handler(request, response, config);
  };

  const server =
    httpMode === "https"
      ? https.createServer(
          {
            key: fs.readFileSync(args["--ssl-key"]),
            cert: fs.readFileSync(args["--ssl-cert"])
          },
          serverHandler
        )
      : http.createServer(serverHandler);

  server.on("error", err => {
    if (
      err.code === "EADDRINUSE" &&
      endpoint.length === 1 &&
      !isNaN(endpoint[0])
    ) {
      startEndpoint([0], config, args, endpoint[0]);
      return;
    }

    console.error(error(`Failed to serve: ${err.stack}`));
    process.exit(1);
  });

  server.listen(...endpoint, async () => {
    const details = server.address();
    registerShutdown(() => server.close());

    let localAddress = null;
    let networkAddress = null;

    if (typeof details === "string") {
      localAddress = details;
    } else if (typeof details === "object" && details.port) {
      const address = details.address === "::" ? "localhost" : details.address;
      const ip = getNetworkAddress();

      localAddress = `${httpMode}://${address}:${details.port}`;
      networkAddress = `${httpMode}://${ip}:${details.port}`;
    }

    if (isTTY && process.env.NODE_ENV !== "production") {
      let message = chalk.green("Serving!");

      if (localAddress) {
        const prefix = networkAddress ? "- " : "";
        const space = networkAddress ? "            " : "  ";

        message += `\n\n${chalk.bold(
          `${prefix}Local:`
        )}${space}${localAddress}`;
      }

      if (networkAddress) {
        message += `\n${chalk.bold("- On Your Network:")}  ${networkAddress}`;
        QRCode.toString(
          `${networkAddress}`,
          { version: parseInt(args["--qr-size"]) < 2 ? 2 : args["--qr-size"] },
          function(err, url) {
            message += `\n${chalk.bold(
              `- Qr code[` + args["--qr-size"] + " " + args["--qr-color"]
            ) + "]: "}${getColor(args["--qr-color"], url)} `;
          }
        );
      }

      if (previous) {
        message += chalk.red(
          `\n\nThis port was picked because ${chalk.underline(
            previous
          )} is in use.`
        );
      }

      if (clipboard) {
        try {
          await copy(localAddress);
          message += `\n\n${chalk.grey("Copied local address to clipboard!")}`;
        } catch (err) {
          console.error(error(`Cannot copy to clipboard: ${err.message}`));
        }
      }

      console.log(
        boxen(message, {
          padding: 1,
          borderColor: "green",
          margin: 1
        })
      );
    } else {
      const suffix = localAddress ? ` at ${localAddress}` : "";
      console.log(info(`Accepting connections${suffix}`));
    }
  });
};

const loadConfig = async (cwd, entry, args) => {
  const files = ["serve.json", "now.json", "package.json"];

  if (args["--config"]) {
    files.unshift(args["--config"]);
  }

  const config = {};

  for (const file of files) {
    const location = path.resolve(entry, file);
    let content = null;

    try {
      content = await readFile(location, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        continue;
      }

      console.error(error(`Not able to read ${location}: ${err.message}`));
      process.exit(1);
    }

    try {
      content = JSON.parse(content);
    } catch (err) {
      console.error(
        error(`Could not parse ${location} as JSON: ${err.message}`)
      );
      process.exit(1);
    }

    if (typeof content !== "object") {
      console.error(
        warning(`Didn't find a valid object in ${location}. Skipping...`)
      );
      continue;
    }

    try {
      switch (file) {
        case "now.json":
          content = content.static;
          break;
        case "package.json":
          content = content.now.static;
          break;
      }
    } catch (err) {
      continue;
    }

    Object.assign(config, content);
    console.log(info(`Discovered configuration in \`${file}\``));

    if (file === "now.json" || file === "package.json") {
      console.error(
        warning(
          "The config files `now.json` and `package.json` are deprecated. Please use `serve.json`."
        )
      );
    }

    break;
  }

  if (entry) {
    const { public } = config;
    config.public = path.relative(
      cwd,
      public ? path.resolve(entry, public) : entry
    );
  }

  if (Object.keys(config).length !== 0) {
    const ajv = new Ajv();
    const validateSchema = ajv.compile(schema);

    if (!validateSchema(config)) {
      const defaultMessage = error("The configuration you provided is wrong:");
      const { message, params } = validateSchema.errors[0];

      console.error(`${defaultMessage}\n${message}\n${JSON.stringify(params)}`);
      process.exit(1);
    }
  }

  // "ETag" headers are enabled by default unless `--no-etag` is provided
  config.etag = !args["--no-etag"];

  return config;
};

(async () => {
  let args = null;

  try {
    args = arg({
      "--qr-color": String,
      "--qr-size": String,
      "--help": Boolean,
      "--version": Boolean,
      "--listen": [parseEndpoint],
      "--single": Boolean,
      "--debug": Boolean,
      "--config": String,
      "--no-clipboard": Boolean,
      "--no-compression": Boolean,
      "--no-etag": Boolean,
      "--symlinks": Boolean,
      "--ssl-cert": String,
      "--ssl-key": String,
      "-h": "--help",
      "-v": "--version",
      "-l": "--listen",
      "-s": "--single",
      "-d": "--debug",
      "-c": "--config",
      "-n": "--no-clipboard",
      "-u": "--no-compression",
      "-S": "--symlinks",
      // This is deprecated and only for backwards-compatibility.
      "-p": "--listen"
    });
  } catch (err) {
    console.error(error(err.message));
    process.exit(1);
  }

  if (process.env.NO_UPDATE_CHECK !== "1") {
    await updateCheck(args["--debug"]);
  }

  if (args["--version"]) {
    console.log(pkg.version);
    return;
  }

  if (args["--help"]) {
    console.log(getHelp());
    return;
  }

  if (!args["--listen"]) {
    // Default endpoint
    args["--listen"] = [[process.env.PORT || 8080]];
  }
  if (!args["--qr-size"]) {
    // Default endpoint
    args["--qr-size"] = "3";
  }
  if (!args["--qr-color"]) {
    // Default endpoint
    args["--qr-color"] = "blue";
  }
  if (args._.length > 1) {
    console.error(error("Please provide one path argument at maximum"));
    process.exit(1);
  }

  const cwd = process.cwd();
  const entry = args._.length > 0 ? path.resolve(args._[0]) : cwd;

  const config = await loadConfig(cwd, entry, args);

  if (args["--single"]) {
    const { rewrites } = config;
    const existingRewrites = Array.isArray(rewrites) ? rewrites : [];

    // As the first rewrite rule, make `--single` work
    config.rewrites = [
      {
        source: "**",
        destination: "/index.html"
      },
      ...existingRewrites
    ];
  }

  if (args["--symlinks"]) {
    config.symlinks = true;
  }

  for (const endpoint of args["--listen"]) {
    startEndpoint(endpoint, config, args);
  }

  registerShutdown(() => {
    console.log(`\n${info("Gracefully shutting down. Please wait...")}`);

    process.on("SIGINT", () => {
      console.log(`\n${warning("Force-closing all open sockets...")}`);
      process.exit(0);
    });
  });
})();
