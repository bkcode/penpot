ARG PENPOT_VERSION=2.18.5
FROM penpotapp/frontend:${PENPOT_VERSION}
USER root
COPY --chmod=0644 sidebar.css /var/www/app/css/selfhost-sidebar.css
COPY --chmod=0644 login-defaults.js /var/www/app/js/selfhost-login-defaults.js
COPY --chmod=0644 login-defaults.conf /etc/nginx/overrides/server.d/selfhost-login.conf
COPY --chmod=0644 entrypoint.sh /selfhost-entrypoint.sh
RUN grep -q 'main_ui_dashboard_subscription__nitrate-banner' /var/www/app/css/main.css \
    && grep -q 'main_ui_dashboard_subscription__nitrate-current-plan' /var/www/app/css/main.css \
    && sed -i 's|</head>|<link rel="stylesheet" href="/css/selfhost-sidebar.css?v=1"><script src="/js/selfhost-login-defaults.js?v=2" defer></script></head>|' /var/www/app/index.html \
    && rm -f /var/www/app/index.html.gz /var/www/app/index.html.br
USER penpot:penpot
ENTRYPOINT ["/bin/bash", "/selfhost-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
