.PHONY: all web bin install clean

all: web bin

web:
	cd web && npm run build
	rm -rf server/dist && cp -r web/dist server/dist

bin:
	go vet ./... && go build -o git-graph ./server

install: all
	cp deploy/git-graph.service ~/.config/systemd/user/
	systemctl --user daemon-reload
	systemctl --user restart git-graph

clean:
	rm -rf git-graph server/dist web/dist
