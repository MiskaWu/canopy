.PHONY: all web bin install clean

all: web bin

web:
	cd web && npm run build
	rm -rf server/dist && cp -r web/dist server/dist

bin:
	go vet ./... && go build -o canopy ./server

install: all
	cp deploy/canopy.service ~/.config/systemd/user/
	systemctl --user daemon-reload
	systemctl --user restart canopy

clean:
	rm -rf canopy server/dist web/dist
