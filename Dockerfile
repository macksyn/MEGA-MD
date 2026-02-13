FROM quay.io/qasimtech/mega-bot:latest

WORKDIR /root/mega-md

RUN git clone https://github.com/macksyn/MEGA-MD . && \
    npm install

EXPOSE 5000

CMD ["npm", "start"]
