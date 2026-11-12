# The default Bot desktop remains available without Firefox or networking.
FROM localhost/yharness-vps-bot:24.04

RUN apt-get update \
    && apt-get install --no-install-recommends --yes curl dbus-x11 fonts-dejavu-core gpg \
    && install -d -m 0755 /etc/apt/keyrings \
    && install -d -m 0700 /tmp/yh-mozilla-gnupg \
    && curl --fail --silent --show-error --max-time 45 https://packages.mozilla.org/apt/repo-signing-key.gpg \
       -o /etc/apt/keyrings/mozilla.asc \
    && chmod 0644 /etc/apt/keyrings/mozilla.asc \
    && test "$(gpg --homedir /tmp/yh-mozilla-gnupg --batch --with-colons --show-keys /etc/apt/keyrings/mozilla.asc \
       | awk -F: '$1 == "pub" { primary = 1; next } $1 == "fpr" && primary { print $10; primary = 0 }')" \
       = 35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3 \
    && printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/mozilla.asc] https://packages.mozilla.org/apt mozilla main' \
       > /etc/apt/sources.list.d/mozilla.list \
    && printf '%s\n' 'Package: firefox-esr' 'Pin: origin packages.mozilla.org' 'Pin-Priority: 1001' \
       > /etc/apt/preferences.d/mozilla \
    && apt-get update \
    && apt-get install --no-install-recommends --yes firefox-esr \
    && rm -rf /tmp/yh-mozilla-gnupg /var/lib/apt/lists/*

COPY start.sh /usr/local/bin/yharness-vps-bot-start
COPY browser-menu.xml /etc/xdg/openbox/menu.xml
RUN chmod 0755 /usr/local/bin/yharness-vps-bot-start
ENV YH_VPS_BOT_BROWSER=firefox
