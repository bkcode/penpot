ARG PENPOT_VERSION=2.18.5
FROM penpotapp/frontend:${PENPOT_VERSION}
USER root
COPY sidebar.css /var/www/app/css/selfhost-sidebar.css
RUN grep -q 'main_ui_dashboard_subscription__nitrate-banner' /var/www/app/css/main.css \
    && grep -q 'main_ui_dashboard_subscription__nitrate-current-plan' /var/www/app/css/main.css \
    && sed -i 's|</head>|<link rel="stylesheet" href="/css/selfhost-sidebar.css?v=1"></head>|' /var/www/app/index.html \
    && rm -f /var/www/app/index.html.gz /var/www/app/index.html.br
USER penpot:penpot
